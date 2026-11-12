/** Capture a notification's devices inside its producer's transaction; no payload or credentials. */
import { isTransaction, sql, type Executor } from '@purlay/db';
import { PUSH_PENDING_PER_PERSON, PUSH_PERSON_LOCK, PUSH_TTL_SECONDS } from './push-policy';

/** The producer owns the source row and has already checked its recipients. */
export interface PushWork {
  readonly source: 'message' | 'inbox';
  readonly sourceId: string;
  readonly recordId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly module: string;
  readonly kind: string;
  readonly createdAt: Date;
}

export const enqueuePush = async (
  transaction: Executor,
  now: Date,
  work: readonly PushWork[],
  perPersonMax = PUSH_PENDING_PER_PERSON,
): Promise<void> => {
  if (work.length === 0) return;
  if (!isTransaction(transaction)) throw new Error('Push work must commit with its source');
  if (!Number.isInteger(perPersonMax) || perPersonMax < 1 || perPersonMax > PUSH_PENDING_PER_PERSON)
    throw new Error('Invalid pending push bound');
  // Disable serializes with this read and cancels all prior work in the same settings transaction.
  const setting = await transaction
    .selectFrom('server_settings')
    .select(['push_enabled', 'push_public_key'])
    .where('id', '=', true)
    .forShare()
    .executeTakeFirst();
  if (setting?.push_enabled !== true || setting.push_public_key === null) return;
  const people = [...new Set(work.map((item) => item.userId))].sort();
  // Same order across overlapping recipient sets; a worker tries this lock without waiting.
  for (const person of people)
    await sql`select pg_advisory_xact_lock(hashtextextended(${person}, ${PUSH_PERSON_LOCK}))`.execute(
      transaction,
    );
  const sessions = await transaction
    .selectFrom('sessions')
    .select(['id', 'user_id'])
    .where('user_id', 'in', people)
    .where('expires_at', '>', now)
    .orderBy('id')
    .execute();
  if (sessions.length === 0) return;
  // A session snapshot, not a late session lock: erasure owns sessions before the source's workspace.
  // Subscription deletion serializes here; generation/session/owner are checked again at each handoff.
  const candidates = await transaction
    .selectFrom('push_subscriptions')
    .select(['id', 'user_id', 'session_id', 'generation'])
    .where('user_id', 'in', people)
    .where(
      'session_id',
      'in',
      sessions.map((row) => row.id),
    )
    .where('server_key', '=', setting.push_public_key)
    .orderBy('id')
    .forKeyShare()
    .execute();
  const sessionOwners = new Map(sessions.map((row) => [row.id, row.user_id]));
  const devices = candidates.filter((row) => sessionOwners.get(row.session_id) === row.user_id);
  const rows = work.filter(
    (item) =>
      item.createdAt.getTime() + PUSH_TTL_SECONDS * 1_000 > now.getTime() &&
      devices.some((device) => device.user_id === item.userId),
  );
  if (rows.length === 0) return;
  const budgets = new Map(
    rows
      .filter((item) => item.source === 'inbox')
      .map((item) => [JSON.stringify([item.userId, item.module, item.kind]), item]),
  );
  if (budgets.size > 0)
    await transaction
      .insertInto('push_notice_budgets')
      .values(
        [...budgets.values()].map((item) => ({
          user_id: item.userId,
          module: item.module,
          kind: item.kind,
          next_at: now,
          updated_at: now,
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['user_id', 'module', 'kind']).doUpdateSet({
          updated_at: sql<Date>`greatest(push_notice_budgets.updated_at, excluded.updated_at)`,
        }),
      )
      .execute();
  const inserted = await transaction
    .insertInto('push_intents')
    .values(
      rows.map((item) => ({
        source_kind: item.source,
        source_id: item.sourceId,
        record_id: item.recordId,
        workspace_id: item.workspaceId,
        user_id: item.userId,
        module: item.module,
        kind: item.kind,
        created_at: item.createdAt,
        expires_at: new Date(item.createdAt.getTime() + PUSH_TTL_SECONDS * 1_000),
        next_check_at: now,
        state: item.source === 'message' ? 'admitted' : 'pending',
      })),
    )
    .onConflict((conflict) => conflict.columns(['source_kind', 'source_id']).doNothing())
    .returning(['id', 'user_id'])
    .execute();
  const targets = inserted.flatMap((intent) =>
    devices
      .filter((device) => device.user_id === intent.user_id)
      .map((device) => ({
        intent_id: intent.id,
        subscription_id: device.id,
        generation: device.generation,
        session_id: device.session_id,
        next_attempt_at: now,
      })),
  );
  if (targets.length > 0) await transaction.insertInto('push_deliveries').values(targets).execute();
  // Only actively deliverable occurrences count toward the bound; terminal receipts expire with them.
  await sql`
    with ranked as (
      select id, row_number() over (partition by user_id order by created_at desc, id desc) as rank
      from push_intents where user_id in (${sql.join(people)})
        and state in ('pending', 'admitted') and expires_at > ${now}
    ), overflow as (
      update push_intents set state = 'overflow' where id in (select id from ranked where rank > ${perPersonMax})
      returning id
    )
    update push_deliveries set state = 'canceled', lease_id = null
    where intent_id in (select id from overflow) and state = 'pending'
  `.execute(transaction);
};
