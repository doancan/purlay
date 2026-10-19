/**
 * A delivery from GitHub to a repository's feed (#79, D-134 §4–8).
 *
 * Nobody is signed in: the feed's secret is the only credential. The feed is found by the id in the
 * address; the signature over the bytes as sent is checked in constant time before a byte of them is
 * believed; only then is the feed's own bucket charged — so a stranger who knows an address spends
 * nothing of it — and the body read. A delivery is posted once: its id is recorded in the transaction
 * that posts it, and the same id again posts nothing. The message is nobody's and is counted unread
 * for everybody (D-134 §6–7); it arrives by the path a person's does (`publishArrival`).
 *
 * What fails after the signature held is said where the feed was set up — the reason and its time —
 * and answered so GitHub shows the delivery failed. Every delivery is one line of the log: feed,
 * delivery, event and outcome, never the body.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import type { Executor } from '@purlay/db';
import {
  GitHubFeedEventName,
  Uuid,
  messageId,
  type GitHubFeedFailure,
  type WebhookAnswer,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { SealBroken, type CredentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { countArrival } from '../messages/delivery';
import { publishArrival } from '../messages/messages';
import { readBuilt } from '../messages/reader';
import { readDelivery, summaryOf } from './github-events';

export interface WebhookDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly cipher: CredentialCipher;
  readonly bus: EventBus;
  readonly log: Logger;
  /** Whether this feed may post one more now: its own bucket, charged once its signature held. */
  readonly mayDeliver: (feedId: string) => Promise<boolean>;
}

export interface Delivery {
  readonly feedId: string;
  /** `X-Hub-Signature-256`, `X-GitHub-Event` and `X-GitHub-Delivery`, as sent; null when absent. */
  readonly signature: string | null;
  readonly event: string | null;
  readonly deliveryId: string | null;
  readonly body: Uint8Array;
}

/** What became of a delivery GitHub may be told about: each a `2xx` (`WebhookAnswer`). */
export type Outcome = WebhookAnswer['outcome'];

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;
const DELIVERY_ID = /^[0-9A-Za-z-]{1,64}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

const notFound = (): AppError =>
  new AppError({ code: 'GITHUB_FEED_NOT_FOUND', message: 'Feed not found.' });

const unsigned = (): AppError =>
  new AppError({
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'The signature does not match this feed’s secret.',
  });

/** Whether `header` is the HMAC-SHA256 of `body` under `secret`, compared in constant time. */
export const signedBy = (secret: string, body: Uint8Array, header: string | null): boolean => {
  const given = header === null ? null : SIGNATURE.exec(header)?.[1];
  if (given === undefined || given === null) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  // Both are 32 bytes: the pattern above holds the header to 64 hex digits.
  return timingSafeEqual(Buffer.from(given, 'hex'), expected);
};

interface FeedRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly repository_full_name: string;
  readonly repository_id: string | null;
  readonly events: string[];
  readonly secret_encrypted: string;
  readonly archived_at: Date | null;
}

const feedOf = async (executor: Executor, feedId: string): Promise<FeedRow | undefined> =>
  await executor
    .selectFrom('github_repo_feeds')
    .innerJoin('channels', 'channels.id', 'github_repo_feeds.channel_id')
    // A workspace deleted is no tenant to post into: its feeds are not there (`tenancy.ts`).
    .innerJoin('workspaces', 'workspaces.id', 'github_repo_feeds.workspace_id')
    .select([
      'github_repo_feeds.id',
      'github_repo_feeds.workspace_id',
      'github_repo_feeds.channel_id',
      'github_repo_feeds.repository_full_name',
      'github_repo_feeds.repository_id',
      'github_repo_feeds.events',
      'github_repo_feeds.secret_encrypted',
    ])
    .select('channels.deleted_at as archived_at')
    .where('github_repo_feeds.id', '=', feedId)
    .where('workspaces.deleted_at', 'is', null)
    .executeTakeFirst();

/**
 * Whether there is such a feed, asked before a delivery's body is read (D-134 §4): an address that
 * names none costs a lookup, never a read. Not an id at all is the same as no such feed.
 */
export const requireFeed = async (executor: Executor, feedId: string): Promise<void> => {
  if (!Value.Check(Uuid, feedId) || (await feedOf(executor, feedId)) === undefined) {
    throw notFound();
  }
};

/** Said where the feed was set up, in a statement of its own: it stands whatever the answer is. */
const failed = async (
  executor: Executor,
  clock: Clock,
  feedId: string,
  reason: GitHubFeedFailure,
): Promise<void> => {
  const now = clock.now();
  await executor
    .updateTable('github_repo_feeds')
    .set({ last_delivery_at: now, last_failure: reason, last_failure_at: now })
    .where('id', '=', feedId)
    .execute();
};

export const receiveDelivery = async (
  dependencies: WebhookDependencies,
  delivery: Delivery,
): Promise<Outcome> => {
  const { database, clock, cipher, log, mayDeliver } = dependencies;
  // Not an id at all is the same as no such feed — never a database error.
  if (!Value.Check(Uuid, delivery.feedId)) throw notFound();
  const feed = await feedOf(database, delivery.feedId);
  if (feed === undefined) throw notFound();

  let secret: string;
  try {
    secret = await cipher.open(Buffer.from(feed.secret_encrypted, 'base64'), feed.id);
  } catch (error) {
    if (!(error instanceof SealBroken)) throw error;
    // The operator's to fix, and said to them; to GitHub it is a failure like any other of ours.
    log.error('a feed’s webhook secret does not open: was ENCRYPTION_KEY changed?', {
      feedId: feed.id,
    });
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
  }
  if (!signedBy(secret, delivery.body, delivery.signature)) throw unsigned();

  const line = { feedId: feed.id, deliveryId: delivery.deliveryId, event: delivery.event };
  if (
    delivery.event === null ||
    !EVENT_NAME.test(delivery.event) ||
    delivery.deliveryId === null ||
    !DELIVERY_ID.test(delivery.deliveryId)
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A delivery names its event and its id.',
      details: { fields: { headers: 'X-GitHub-Event and X-GitHub-Delivery are required' } },
    });
  }
  const refuse = async (reason: GitHubFeedFailure, error: AppError): Promise<never> => {
    await failed(database, clock, feed.id, reason);
    log.warn('github delivery', { ...line, outcome: reason });
    throw error;
  };
  // GitHub does not send it again on its own: a delivery refused here is said on the feed.
  if (!(await mayDeliver(feed.id))) {
    return await refuse(
      'rate_limited',
      new AppError({ code: 'RATE_LIMITED', message: 'Too many deliveries. Slow down.' }),
    );
  }
  if (feed.archived_at !== null) return await refuse('channel_archived', notFound());

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(delivery.body));
  } catch {
    // Signed, so GitHub's, and not JSON: said on the feed, and answered as the body it was.
    return await refuse(
      'payload_invalid',
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'The body is not JSON.',
        details: { fields: { body: 'is not JSON' } },
      }),
    );
  }
  const wanted = feed.events.filter((name) => Value.Check(GitHubFeedEventName, name));
  const reading = readDelivery(delivery.event, body, wanted);
  if (reading.kind === 'invalid') {
    return await refuse(
      'payload_invalid',
      new AppError({
        code: 'VALIDATION_FAILED',
        message: 'The body is not the event GitHub documents.',
        details: { fields: { body: 'is not the event it names' } },
      }),
    );
  }

  // The repository is the feed's: by its number once known, by its name until then.
  const envelope = reading.envelope;
  if (envelope !== null) {
    const known = feed.repository_id;
    const same =
      known === null
        ? envelope.repository.full_name.toLowerCase() === feed.repository_full_name
        : String(envelope.repository.id) === known;
    if (!same) {
      return await refuse(
        'repository_mismatch',
        new AppError({
          code: 'GITHUB_REPOSITORY_MISMATCH',
          message: 'This feed is for another repository.',
        }),
      );
    }
  }

  const now = clock.now();
  const seen = {
    last_delivery_at: now,
    ...(envelope === null ? {} : { repository_id: String(envelope.repository.id) }),
  };
  // A renamed repository keeps its feed: its number is what is matched, and its new name is kept —
  // unless another feed of the channel holds that name, which keeps it, and this one its old one.
  const renamed = async (executor: Executor): Promise<void> => {
    if (envelope === null) return;
    const name = envelope.repository.full_name.toLowerCase();
    if (name === feed.repository_full_name) return;
    await executor
      .updateTable('github_repo_feeds')
      .set({ repository_full_name: name })
      .where('id', '=', feed.id)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('github_repo_feeds as other')
              .select('other.id')
              .where('other.channel_id', '=', feed.channel_id)
              .where('other.repository_full_name', '=', name),
          ),
        ),
      )
      .execute();
  };
  if (reading.kind === 'ignored') {
    await database.updateTable('github_repo_feeds').set(seen).where('id', '=', feed.id).execute();
    await renamed(database);
    const outcome = delivery.event === 'ping' ? 'pinged' : 'ignored';
    log.info('github delivery', { ...line, outcome });
    return outcome;
  }

  const posted = await atomicallyOn(database)(async (transaction) => {
    const recorded = await transaction
      .insertInto('github_deliveries')
      .values({ feed_id: feed.id, delivery_id: delivery.deliveryId ?? '', received_at: now })
      .onConflict((conflict) => conflict.columns(['feed_id', 'delivery_id']).doNothing())
      .returning('delivery_id')
      .executeTakeFirst();
    if (recorded === undefined) return null;
    const id = messageId(now);
    await transaction
      .insertInto('messages')
      .values({
        id,
        workspace_id: feed.workspace_id,
        channel_id: feed.channel_id,
        sender_id: null,
        message_type: 'system_event',
        metadata: reading.event,
        content: summaryOf(reading.event),
        created_at: now,
      })
      .execute();
    // Unread for everybody, and needing nobody: an event names nobody and tells nobody (D-134 §7).
    const recipients = await countArrival(
      transaction,
      feed.channel_id,
      { id, reply: false },
      null,
      [],
    );
    await transaction
      .updateTable('github_repo_feeds')
      .set(seen)
      .where('id', '=', feed.id)
      .execute();
    await renamed(transaction);
    await transaction
      .updateTable('channels')
      .set({ last_message_at: now })
      .where('id', '=', feed.channel_id)
      .where((eb) => eb.or([eb('last_message_at', 'is', null), eb('last_message_at', '<', now)]))
      .execute();
    const message = await readBuilt(transaction, id);
    if (message === undefined) throw new Error(`event ${id} was written and is not there`);
    return { message, recipients };
  });
  if (posted === null) {
    log.info('github delivery', { ...line, outcome: 'duplicate' });
    return 'duplicate';
  }
  await publishArrival(
    { bus: dependencies.bus, clock, log },
    feed.channel_id,
    posted.message,
    null,
    posted.recipients,
  );
  log.info('github delivery', { ...line, outcome: 'posted' });
  return 'posted';
};
