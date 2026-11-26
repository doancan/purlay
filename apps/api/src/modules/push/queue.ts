/** Short PostgreSQL claims; provider I/O never holds a transaction or an advisory lock (#1405). */
import { sql, type Executor, type RawBuilder } from '@purlay/db';
import { NEEDS_YOU } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import {
  NOTICE_PUSH_BUDGET,
  PUSH_ATTEMPTS_MAX,
  PUSH_LEASE_MS,
  PUSH_PERSON_LOCK,
  PUSH_POSTS_PER_PERSON,
} from '../../platform/push-policy';
import type { PushWork } from '../../platform/push-work';
import { companySessionAllowsWorkspace } from '../../platform/company-session';

export interface PushClaim extends PushWork {
  readonly intentId: string;
  readonly subscriptionId: string;
  readonly generation: string;
  readonly sessionId: string;
  readonly leaseId: string;
  readonly expiresAt: Date;
  readonly attempts: number;
  readonly apnsScope?: string;
}

export interface PushQueue {
  readonly database: Executor;
  readonly clock: Clock;
  readonly owner: string;
  /** Only pushed kinds declared by modules this process actually runs. */
  readonly inboxKinds: ReadonlyMap<string, string>;
  readonly apnsScope?: string;
}

/** A worker always handles Web Push and handles only its configured APNs app and environment. */
const supportedTarget = (
  apnsScope: string | undefined,
  webAllowed: RawBuilder<boolean>,
): RawBuilder<boolean> =>
  apnsScope === undefined
    ? sql<boolean>`(${webAllowed} and d.apns_session_id is null)`
    : sql<boolean>`((${webAllowed} and d.apns_session_id is null) or exists (
        select 1 from apns_subscriptions native
        where native.session_id = d.apns_session_id and native.provider_scope = ${apnsScope}
      ))`;

const currentProvider = (claim: PushClaim, serverKey: string | undefined): RawBuilder<boolean> =>
  claim.apnsScope === undefined
    ? sql<boolean>`d.apns_session_id is null and exists (
        select 1 from server_settings
        where id and push_enabled and push_public_key = ${serverKey ?? null}
      )`
    : sql<boolean>`exists (
        select 1 from apns_subscriptions native
        where native.session_id = d.apns_session_id
          and native.generation = d.generation and native.provider_scope = ${claim.apnsScope}
      )`;

/** Parent before children, shared by claim and acknowledgement: no child/parent lock inversion. */
export const reschedulePush = async (tx: Executor, intentId: string, now: Date): Promise<void> => {
  const next = await tx
    .selectFrom('push_deliveries as d')
    .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
    .select((eb) => eb.fn.min<Date | null>('d.next_attempt_at').as('due'))
    .where('d.intent_id', '=', intentId)
    .where('d.state', '=', 'pending')
    .where(sql<boolean>`(not p.web_canceled or d.apns_session_id is not null)`)
    .executeTakeFirstOrThrow();
  await tx
    .updateTable('push_intents')
    .set({ next_check_at: next.due ?? now, ...(next.due === null ? { state: 'completed' } : {}) })
    .where('id', '=', intentId)
    .where('state', 'in', ['pending', 'admitted'])
    .execute();
};

/** Admission is charged once for the occurrence, shared by its devices, retries and every node. */
const admit = async (
  tx: Executor,
  intent: { id: string; user_id: string; module: string; kind: string; state: string },
  now: Date,
): Promise<boolean> => {
  if (intent.state === 'admitted') return true;
  const budget = await tx
    .selectFrom('push_notice_budgets')
    .select('next_at')
    .where('user_id', '=', intent.user_id)
    .where('module', '=', intent.module)
    .where('kind', '=', intent.kind)
    .forUpdate()
    .executeTakeFirst();
  if (budget === undefined) throw new Error('Push occurrence has no admission budget');
  const interval = 1_000 / NOTICE_PUSH_BUDGET.perSecond;
  const allowed =
    budget.next_at.getTime() <= now.getTime() + (NOTICE_PUSH_BUDGET.burst - 1) * interval;
  if (allowed)
    await tx
      .updateTable('push_notice_budgets')
      .set({
        next_at: new Date(Math.max(budget.next_at.getTime(), now.getTime()) + interval),
        updated_at: now,
      })
      .where('user_id', '=', intent.user_id)
      .where('module', '=', intent.module)
      .where('kind', '=', intent.kind)
      .execute();
  await tx
    .updateTable('push_intents')
    .set({ state: allowed ? 'admitted' : 'throttled' })
    .where('id', '=', intent.id)
    .execute();
  if (!allowed)
    await tx
      .updateTable('push_deliveries')
      .set({ state: 'canceled', lease_id: null })
      .where('intent_id', '=', intent.id)
      .where('state', '=', 'pending')
      .execute();
  return allowed;
};

export const claimPush = async (queue: PushQueue): Promise<PushClaim | undefined> =>
  await atomicallyOn(queue.database)(async (tx) => {
    const now = queue.clock.now();
    const knownInbox = [...queue.inboxKinds].map(
      ([kind, module]) =>
        sql<boolean>`(p.source_kind = 'inbox' and p.kind = ${kind} and p.module = ${module})`,
    );
    const known = sql<boolean>`(p.source_kind = 'message' and p.module = ${queue.owner}
      and p.kind in (${sql.join([...NEEDS_YOU, 'reminder'])}))`;
    const candidates = await tx
      .selectFrom('push_intents as p')
      .select(['p.id', 'p.user_id'])
      .where('p.state', 'in', ['pending', 'admitted'])
      .where('p.expires_at', '>', now)
      .where('p.next_check_at', '<=', now)
      .where(sql<boolean>`(${sql.join([known, ...knownInbox], sql` or `)})`)
      // Provider-specific work cannot hide other due intents from this worker's bounded sample.
      .where(
        sql<boolean>`(
        exists (
          select 1 from push_deliveries d where d.intent_id = p.id and d.state = 'pending'
            and d.next_attempt_at <= ${now} and ${supportedTarget(queue.apnsScope, sql<boolean>`not p.web_canceled`)}
        ) or not exists (
          select 1 from push_deliveries d where d.intent_id = p.id and d.state = 'pending'
            and d.next_attempt_at <= ${now}
            and (not p.web_canceled or d.apns_session_id is not null)
        )
      )`,
      )
      // A saturated person's backlog cannot hide another person's due work behind the look-ahead.
      .where(
        sql<boolean>`(
        select count(*) from push_deliveries d join push_intents live on live.id = d.intent_id
        where live.user_id = p.user_id and live.state = 'admitted' and live.expires_at > ${now}
          and d.state = 'pending' and d.lease_id is not null and d.next_attempt_at > ${now}
          and (not live.web_canceled or d.apns_session_id is not null)
      ) < ${PUSH_POSTS_PER_PERSON}`,
      )
      .orderBy('p.next_check_at')
      .orderBy('p.id')
      .limit(64)
      .execute();
    for (const candidate of candidates) {
      const lock = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(
        hashtextextended(${candidate.user_id}, ${PUSH_PERSON_LOCK})) as acquired`.execute(tx);
      if (lock.rows[0]?.acquired !== true) continue;
      const intent = await tx
        .selectFrom('push_intents')
        .selectAll()
        .where('id', '=', candidate.id)
        .where('state', 'in', ['pending', 'admitted'])
        .where('expires_at', '>', now)
        .where('next_check_at', '<=', now)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (intent === undefined) continue;
      // The advisory lock serializes the share across concurrent claims on different nodes.
      const active = await tx
        .selectFrom('push_deliveries as d')
        .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('p.user_id', '=', intent.user_id)
        .where('p.state', '=', 'admitted')
        .where('p.expires_at', '>', now)
        .where('d.state', '=', 'pending')
        .where('d.lease_id', 'is not', null)
        .where('d.next_attempt_at', '>', now)
        .where(sql<boolean>`(not p.web_canceled or d.apns_session_id is not null)`)
        .executeTakeFirstOrThrow();
      if (Number(active.n) >= PUSH_POSTS_PER_PERSON) continue;
      if (!(await admit(tx, intent, now))) continue;
      const target = await tx
        .selectFrom('push_deliveries as d')
        .leftJoin('push_subscriptions as web', 'web.id', 'd.web_subscription_id')
        .leftJoin('apns_subscriptions as native', 'native.session_id', 'd.apns_session_id')
        .selectAll('d')
        .where('d.intent_id', '=', intent.id)
        .where('d.state', '=', 'pending')
        .where('d.next_attempt_at', '<=', now)
        .where(supportedTarget(queue.apnsScope, sql<boolean>`${!intent.web_canceled}`))
        .orderBy('d.next_attempt_at')
        .orderBy(sql`coalesce(web.created_at, native.registered_at)`)
        .orderBy('d.subscription_id')
        .forUpdate(['d'])
        .skipLocked()
        .executeTakeFirst();
      if (target === undefined) {
        await reschedulePush(tx, intent.id, now);
        continue;
      }
      if (target.attempts >= PUSH_ATTEMPTS_MAX) {
        await tx
          .updateTable('push_deliveries')
          .set({ state: 'exhausted', lease_id: null })
          .where('intent_id', '=', intent.id)
          .where('subscription_id', '=', target.subscription_id)
          .where('generation', '=', target.generation)
          .execute();
        await reschedulePush(tx, intent.id, now);
        continue;
      }
      const leaseId = crypto.randomUUID();
      await tx
        .updateTable('push_deliveries')
        .set({
          lease_id: leaseId,
          next_attempt_at: new Date(
            Math.min(now.getTime() + PUSH_LEASE_MS, intent.expires_at.getTime()),
          ),
        })
        .where('intent_id', '=', intent.id)
        .where('subscription_id', '=', target.subscription_id)
        .where('generation', '=', target.generation)
        .execute();
      await reschedulePush(tx, intent.id, now);
      return {
        intentId: intent.id,
        subscriptionId: target.subscription_id,
        generation: target.generation,
        sessionId: target.session_id,
        leaseId,
        expiresAt: intent.expires_at,
        attempts: target.attempts,
        ...(target.apns_session_id !== null && queue.apnsScope !== undefined
          ? { apnsScope: queue.apnsScope }
          : {}),
        source: intent.source_kind === 'message' ? 'message' : 'inbox',
        sourceId: intent.source_id,
        recordId: intent.record_id,
        workspaceId: intent.workspace_id,
        userId: intent.user_id,
        module: intent.module,
        kind: intent.kind,
        createdAt: intent.created_at,
      };
    }
    return undefined;
  });

/** An old process cannot begin another handoff after losing its claim, expiry or server disable. */
export const beginPushAttempt = async (
  database: Executor,
  claim: PushClaim,
  now: Date,
  serverKey?: string,
): Promise<boolean> => {
  const result = await database
    .updateTable('push_deliveries as d')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('d.intent_id', '=', claim.intentId)
    .where('d.subscription_id', '=', claim.subscriptionId)
    .where('d.generation', '=', claim.generation)
    .where('d.lease_id', '=', claim.leaseId)
    .where('d.state', '=', 'pending')
    .where('d.next_attempt_at', '>', now)
    .where('d.attempts', '<', PUSH_ATTEMPTS_MAX)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('push_intents as p')
          .select('p.id')
          .whereRef('p.id', '=', 'd.intent_id')
          .where('p.state', '=', 'admitted')
          .where(sql<boolean>`(not p.web_canceled or d.apns_session_id is not null)`)
          .where('p.expires_at', '>', now),
      ),
    )
    .where(currentProvider(claim, serverKey))
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
};

export const ownsPushClaim = async (
  database: Executor,
  claim: PushClaim,
  now: Date,
  serverKey?: string,
): Promise<boolean> =>
  (await database
    .selectFrom('push_deliveries as d')
    .innerJoin('push_intents as p', 'p.id', 'd.intent_id')
    .innerJoin('sessions as live', (join) =>
      join.onRef('live.id', '=', 'd.session_id').onRef('live.user_id', '=', 'p.user_id'),
    )
    .select('d.intent_id')
    .where('d.intent_id', '=', claim.intentId)
    .where('d.subscription_id', '=', claim.subscriptionId)
    .where('d.generation', '=', claim.generation)
    .where('d.lease_id', '=', claim.leaseId)
    .where('d.state', '=', 'pending')
    .where('p.state', '=', 'admitted')
    .where(sql<boolean>`(not p.web_canceled or d.apns_session_id is not null)`)
    .where('p.expires_at', '>', now)
    .where('live.expires_at', '>', now)
    .where(companySessionAllowsWorkspace('live', sql<string>`p.workspace_id`))
    .where('d.next_attempt_at', '>', now)
    .where(currentProvider(claim, serverKey))
    .executeTakeFirst()) !== undefined;
