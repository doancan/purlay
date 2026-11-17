/** Durable, bounded outgoing delivery. No HTTP request holds a SQL lock (D-312). */
import { createHmac } from 'node:crypto';
import {
  sql,
  tableExists,
  type ExpressionBuilder,
  type Expression,
  type SqlBool,
} from '@purlay/db';
import type { ChatDb, ChatSchema } from '../schema';
import type { Clock } from '../../../platform/clock';
import type { CredentialCipher } from '../../../platform/crypto';
import type { Logger } from '../../../platform/logging';
import { atomicallyOn } from '../../../platform/transactions';
import {
  checkingLookup,
  postExternal,
  systemResolver,
  type FetchOptions,
} from '../../../modules/images/fetch-external';
import { webhookTarget } from './outgoing-webhooks';

const LIFETIME = 86_400_000;
const LEASE = 60_000;
const RETENTION = 7 * LIFETIME;
const BATCH = 20;

interface WebhookReply {
  readonly status: number | null;
  readonly error: string | null;
  readonly retryAfter?: string;
}
export type WebhookPost = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
) => Promise<WebhookReply>;

export const makeWebhookPost =
  (
    options: Omit<FetchOptions, 'maxBytes'> = {
      lookup: checkingLookup(systemResolver),
      timeoutMs: 10_000,
    },
  ): WebhookPost =>
  async (url, headers, body) => {
    const result = await postExternal(url, headers, body, options);
    return result.kind === 'answered'
      ? {
          status: result.status,
          error: null,
          ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }),
        }
      : { status: null, error: 'network_error' };
  };
const webhookPost = makeWebhookPost();

export const webhookSignature = (secret: string, timestamp: string, body: string): string =>
  `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

/** Backoff has jitter and a cap. Retry-After is a lower bound; expiry is enforced by the caller. */
export const nextWebhookAttempt = (
  now: Date,
  attempt: number,
  retryAfter?: string,
  random: () => number = Math.random,
): Date => {
  const delay =
    Math.min(3_600_000, 5_000 * 2 ** Math.min(attempt - 1, 10)) * (0.75 + random() * 0.5);
  const seconds = retryAfter === undefined ? NaN : Number(retryAfter);
  const fromHeader =
    retryAfter === undefined
      ? 0
      : Number.isFinite(seconds) && seconds >= 0
        ? now.getTime() + Math.min(seconds, LIFETIME / 1000) * 1000
        : Date.parse(retryAfter);
  return new Date(
    Math.max(
      now.getTime() + delay,
      Number.isFinite(fromHeader) ? Math.min(fromHeader, now.getTime() + LIFETIME) : 0,
    ),
  );
};

export interface DispatchDependencies {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly log: Logger;
  readonly post?: WebhookPost;
  readonly random?: () => number;
}

const dispatchBatch = async ({
  database,
  clock,
  cipher,
  log,
  post = webhookPost,
  random = Math.random,
}: DispatchDependencies): Promise<{ claimed: number; succeeded: number; failed: number }> => {
  const now = clock.now();
  const token = crypto.randomUUID();
  const claimed = await atomicallyOn(database)(async (db) => {
    // Maintenance is bounded too: stale work cannot be selected while a later batch cleans it.
    const removedSources = db
      .selectFrom('webhook_deliveries as d')
      .innerJoin('messages as m', 'm.id', 'd.message_id')
      .select('d.id')
      .where('m.deleted_at', 'is not', null)
      .where('d.state', 'in', ['pending', 'sending', 'failed'])
      .limit(1000);
    await db
      .updateTable('webhook_deliveries')
      .set({
        state: 'cancelled',
        payload: '{}',
        completed_at: now,
        last_error: 'source_deleted',
        lease_token: null,
        lease_until: null,
      })
      .where('id', 'in', removedSources)
      .execute();
    const expired = db
      .selectFrom('webhook_deliveries')
      .select('id')
      .where('state', 'in', ['pending', 'sending'])
      .where('expires_at', '<=', now)
      .limit(1000);
    await db
      .updateTable('webhook_deliveries')
      .set({
        state: 'failed',
        completed_at: now,
        last_error: 'expired',
        lease_token: null,
        lease_until: null,
      })
      .where('id', 'in', expired)
      .where('state', 'in', ['pending', 'sending'])
      .where('expires_at', '<=', now)
      .execute();
    const rows = await db
      .selectFrom('webhook_deliveries as d')
      .innerJoin('outgoing_webhooks as h', 'h.id', 'd.webhook_id')
      .innerJoin('channels as c', 'c.id', 'h.channel_id')
      .innerJoin('workspaces as w', 'w.id', 'h.workspace_id')
      .leftJoin('messages as m', 'm.id', 'd.message_id')
      .select([
        'd.id',
        'd.webhook_id',
        'd.event_id',
        'd.payload',
        'd.attempt_count',
        'd.expires_at',
        'h.url',
        'h.secret_encrypted',
      ])
      .where('h.paused', '=', false)
      .where('h.revoked_at', 'is', null)
      .where('c.deleted_at', 'is', null)
      .where('w.deleted_at', 'is', null)
      .where('c.type', '!=', 'direct_message')
      .where((eb) =>
        eb.or([
          eb('d.message_id', 'is', null),
          eb.and([eb('m.id', 'is not', null), eb('m.deleted_at', 'is', null)]),
        ]),
      )
      .where('d.expires_at', '>', now)
      .where('d.next_attempt_at', '<=', now)
      .where((eb) =>
        eb.or([
          eb('d.state', '=', 'pending'),
          eb.and([eb('d.state', '=', 'sending'), eb('d.lease_until', '<=', now)]),
        ]),
      )
      .orderBy('d.next_attempt_at')
      .orderBy('d.id')
      .limit(BATCH)
      .forUpdate('d')
      .skipLocked()
      .execute();
    if (rows.length > 0)
      await db
        .updateTable('webhook_deliveries')
        .set({ state: 'sending', lease_token: token, lease_until: new Date(now.getTime() + LEASE) })
        .where(
          'id',
          'in',
          rows.map((row) => row.id),
        )
        .execute();
    return rows;
  });
  let succeeded = 0;
  let failed = 0;
  // Four requests at once; every batch is bounded and the scheduler can run another worker safely.
  for (let offset = 0; offset < claimed.length; offset += 4) {
    await Promise.all(
      claimed.slice(offset, offset + 4).map(async (delivery): Promise<void> => {
        // Decryption is asynchronous: finish it before the last live check, so a revoke or
        // source erasure committed during decryption cannot start an HTTP request afterwards.
        let secret: string | null = null;
        try {
          secret = await cipher.open(
            Buffer.from(delivery.secret_encrypted, 'base64'),
            delivery.webhook_id,
          );
        } catch {
          /* A broken seal becomes a recorded delivery failure below. */
        }
        // Check again immediately before the call: a hook paused/revoked after claiming sends nothing.
        const live = await database
          .selectFrom('webhook_deliveries as d')
          .innerJoin('outgoing_webhooks as h', 'h.id', 'd.webhook_id')
          .innerJoin('channels as c', 'c.id', 'h.channel_id')
          .innerJoin('workspaces as w', 'w.id', 'h.workspace_id')
          .leftJoin('messages as m', 'm.id', 'd.message_id')
          .select(['h.url', 'h.secret_encrypted'])
          .where('d.id', '=', delivery.id)
          .where('d.lease_token', '=', token)
          .where('d.state', '=', 'sending')
          .where('d.expires_at', '>', clock.now())
          .where('h.revoked_at', 'is', null)
          .where('h.paused', '=', false)
          .where('c.deleted_at', 'is', null)
          .where('w.deleted_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('d.message_id', 'is', null),
              eb.and([eb('m.id', 'is not', null), eb('m.deleted_at', 'is', null)]),
            ]),
          )
          .executeTakeFirst();
        if (live?.secret_encrypted !== delivery.secret_encrypted || live.url !== delivery.url) {
          await database
            .updateTable('webhook_deliveries')
            .set({ state: 'pending', lease_token: null, lease_until: null })
            .where('id', '=', delivery.id)
            .where('lease_token', '=', token)
            .where('state', '=', 'sending')
            .execute();
          return;
        }
        const started = clock.now();
        let reply: WebhookReply;
        try {
          if (secret === null) throw new Error('credential unavailable');
          const timestamp = String(Math.floor(started.getTime() / 1000));
          reply = await post(
            webhookTarget(live.url),
            {
              'content-type': 'application/json',
              'user-agent': 'Purlay webhook',
              'x-purlay-id': delivery.event_id,
              'x-purlay-timestamp': timestamp,
              'x-purlay-signature': webhookSignature(secret, timestamp, delivery.payload),
            },
            new TextEncoder().encode(delivery.payload),
          );
        } catch {
          // No exception string: network and decryption errors can contain credentials or target URLs.
          reply = { status: null, error: 'delivery_error' };
        }
        const ended = clock.now();
        const ok = reply.status !== null && reply.status >= 200 && reply.status < 300;
        const retryable =
          reply.status === null ||
          reply.status === 408 ||
          reply.status === 429 ||
          (reply.status >= 500 && reply.status < 600);
        const next = nextWebhookAttempt(
          ended,
          delivery.attempt_count + 1,
          reply.retryAfter,
          random,
        );
        const retry = !ok && retryable && next.getTime() < new Date(delivery.expires_at).getTime();
        const state = ok ? 'succeeded' : retry ? 'pending' : 'failed';
        const recorded = await atomicallyOn(database)(async (db) => {
          const updated = await db
            .updateTable('webhook_deliveries')
            .set({
              state,
              attempt_count: sql<number>`attempt_count + 1`,
              next_attempt_at: next,
              lease_token: null,
              lease_until: null,
              completed_at: state === 'pending' ? null : ended,
              last_status: reply.status,
              last_error: ok
                ? null
                : (reply.error ??
                  (retryable
                    ? retry
                      ? 'retryable_http'
                      : 'retry_window_exhausted'
                    : 'permanent_http')),
            })
            .where('id', '=', delivery.id)
            .where('lease_token', '=', token)
            .where('state', '=', 'sending')
            .returning('id')
            .executeTakeFirst();
          if (updated === undefined) return false;
          await db
            .insertInto('webhook_delivery_attempts')
            .values({
              id: crypto.randomUUID(),
              delivery_id: delivery.id,
              attempted_at: started,
              duration_ms: Math.max(0, ended.getTime() - started.getTime()),
              status: reply.status,
              error: ok ? null : (reply.error ?? 'http_error'),
            })
            .execute();
          return true;
        });
        if (recorded) {
          if (ok) succeeded++;
          else failed++;
          log.info('outgoing webhook delivery', {
            webhookId: delivery.webhook_id,
            deliveryId: delivery.id,
            outcome: state,
            status: reply.status,
          });
        }
      }),
    );
  }
  return { claimed: claimed.length, succeeded, failed };
};

/** Operational payloads are short-lived even while the chat module is disabled. */
export const sweepWebhookDeliveries = async (
  database: ChatDb,
  clock: Clock,
): Promise<{ removed: number }> => {
  if (!(await tableExists(database, 'webhook_deliveries'))) return { removed: 0 };
  const cutoff = new Date(clock.now().getTime() - RETENTION);
  const pastRetention = (
    eb: ExpressionBuilder<ChatSchema, 'webhook_deliveries'>,
  ): Expression<SqlBool> =>
    eb.or([
      eb('completed_at', '<', cutoff),
      eb.and([eb('completed_at', 'is', null), eb('expires_at', '<', cutoff)]),
    ]);
  const old = database
    .selectFrom('webhook_deliveries')
    .select('id')
    .where(pastRetention)
    .orderBy('id')
    .limit(1000);
  let removed = 0;
  for (;;) {
    const result = await database
      .deleteFrom('webhook_deliveries')
      .where('id', 'in', old)
      // Rechecked after any row-lock wait: manual retry may have extended this row's life.
      .where(pastRetention)
      .executeTakeFirst();
    const batch = Number(result.numDeletedRows);
    removed += batch;
    if (batch < 1000) break;
  }
  // Attempts have their own age, including a delivery retried manually for several weeks.
  for (;;) {
    const attempts = database
      .selectFrom('webhook_delivery_attempts')
      .select('id')
      .where('attempted_at', '<', cutoff)
      .limit(1000);
    const result = await database
      .deleteFrom('webhook_delivery_attempts')
      .where('id', 'in', attempts)
      .executeTakeFirst();
    if (Number(result.numDeletedRows) < 1000) break;
  }
  return { removed };
};

/** Drain several small batches; a fast endpoint need not wait a minute after twenty deliveries. */
export const dispatchWebhooks = async (
  dependencies: DispatchDependencies,
): Promise<{ claimed: number; succeeded: number; failed: number }> => {
  const started = dependencies.clock.now().getTime();
  const total = { claimed: 0, succeeded: 0, failed: 0 };
  do {
    const result = await dispatchBatch(dependencies);
    total.claimed += result.claimed;
    total.succeeded += result.succeeded;
    total.failed += result.failed;
    if (result.claimed < BATCH) break;
  } while (total.claimed < 10_000 && dependencies.clock.now().getTime() - started < 45_000);
  return total;
};
