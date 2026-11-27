/** Capture a notification's devices inside its producer's transaction; no payload or credentials. */
import { isTransaction, sql, type Executor } from '@purlay/db';
import { PUSH_PENDING_PER_PERSON, PUSH_PERSON_LOCK, PUSH_TTL_SECONDS } from './push-policy';
import { companySessionAllowsWorkspace } from './company-session';
import { readWorkspaceSessionAccessDecisions } from './workspace-delivery-access';

export const URGENT_REPEAT_KIND = 'urgent_repeat';

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
  /** For a repeat, sourceId identifies the slot and notificationId identifies the original unread notice. */
  readonly repeat?: { readonly notificationId: string; readonly expiresAt: Date };
}

export type PushCapture = (tx: Executor, now: Date, work: readonly PushWork[]) => Promise<void>;

export const enqueuePush = async (
  transaction: Executor,
  now: Date,
  work: readonly PushWork[],
  perPersonMax = PUSH_PENDING_PER_PERSON,
  apnsScope?: string,
): Promise<void> => {
  if (work.length === 0) return;
  if (!isTransaction(transaction)) throw new Error('Push work must commit with its source');
  if (!Number.isInteger(perPersonMax) || perPersonMax < 1 || perPersonMax > PUSH_PENDING_PER_PERSON)
    throw new Error('Invalid pending push bound');
  // Web Push settings serialize with this read. The same row carries the session policy.
  const setting = await transaction
    .selectFrom('server_settings')
    .select([
      'push_enabled',
      'push_public_key',
      'session_idle_timeout_hours',
      'session_max_age_days',
    ])
    .where('id', '=', true)
    .forShare()
    .executeTakeFirst();
  const webKey = setting?.push_enabled ? setting.push_public_key : null;
  if (webKey === null && apnsScope === undefined) return;
  const people = [...new Set(work.map((item) => item.userId))].sort();
  // Same order across overlapping recipient sets; a worker tries this lock without waiting.
  for (const person of people)
    await sql`select pg_advisory_xact_lock(hashtextextended(${person}, ${PUSH_PERSON_LOCK}))`.execute(
      transaction,
    );
  const sessions = await transaction
    .selectFrom('sessions')
    .select(['id', 'user_id', 'company_workspace_id'])
    .where('user_id', 'in', people)
    .where('expires_at', '>', now)
    .where(companySessionAllowsWorkspace('sessions', sql<string>`sessions.company_workspace_id`))
    .orderBy('id')
    .execute();
  if (sessions.length === 0) return;
  // A session snapshot, not a late session lock: erasure owns sessions before the source's workspace.
  // Subscription deletion serializes here. Lock Web Push first, then APNs, in key order.
  const sessionIds = sessions.map((row) => row.id);
  const web =
    webKey === null
      ? []
      : await transaction
          .selectFrom('push_subscriptions')
          .select(['id', 'user_id', 'session_id', 'generation'])
          .where('user_id', 'in', people)
          .where('session_id', 'in', sessionIds)
          .where('server_key', '=', webKey)
          .orderBy('id')
          .forKeyShare()
          .execute();
  const apns =
    apnsScope === undefined
      ? []
      : await transaction
          .selectFrom('apns_subscriptions')
          .select(['session_id', 'generation'])
          .where('session_id', 'in', sessionIds)
          .where('provider_scope', '=', apnsScope)
          .orderBy('session_id')
          .forKeyShare()
          .execute();
  const sessionOwners = new Map(sessions.map((row) => [row.id, row]));
  const devices = [
    ...web.flatMap((row) => {
      const session = sessionOwners.get(row.session_id);
      return session?.user_id === row.user_id
        ? [{ ...row, apnsSessionId: null, companyWorkspaceId: session.company_workspace_id }]
        : [];
    }),
    ...apns.flatMap((row) => {
      const session = sessionOwners.get(row.session_id);
      return session === undefined
        ? []
        : [
            {
              ...row,
              id: row.session_id,
              user_id: session.user_id,
              apnsSessionId: row.session_id,
              companyWorkspaceId: session.company_workspace_id,
            },
          ];
    }),
  ];
  const workspaces = await transaction
    .selectFrom('workspaces')
    .select(['id', 'access_policy_epoch'])
    .where('id', 'in', [...new Set(work.map((item) => item.workspaceId))])
    .where('deleted_at', 'is', null)
    .execute();
  const epochs = new Map(workspaces.map((row) => [row.id, row.access_policy_epoch]));
  const eligible = new Map<string, ReadonlySet<string>>();
  for (const workspace of workspaces)
    if (workspace.access_policy_epoch !== '0') {
      const recipients = new Set(
        work.filter((item) => item.workspaceId === workspace.id).map((item) => item.userId),
      );
      const decisions = await readWorkspaceSessionAccessDecisions(transaction, {
        workspaceId: workspace.id,
        sessionIds: devices
          .filter((device) => recipients.has(device.user_id))
          .map((device) => device.session_id),
        now,
        lifetime: {
          sessionIdleTimeoutHours: setting?.session_idle_timeout_hours ?? null,
          sessionMaxAgeDays: setting?.session_max_age_days ?? null,
        },
      });
      eligible.set(
        workspace.id,
        new Set([...decisions].filter(([, decision]) => decision.allowed).map(([id]) => id)),
      );
    }
  const allowed = (workspaceId: string, sessionId: string): boolean =>
    epochs.get(workspaceId) === '0' || eligible.get(workspaceId)?.has(sessionId) === true;
  const rows = work
    .map((item) => ({
      ...item,
      expiresAt:
        item.repeat?.expiresAt ?? new Date(item.createdAt.getTime() + PUSH_TTL_SECONDS * 1_000),
    }))
    .filter(
      (item) =>
        item.expiresAt > now &&
        (item.repeat === undefined || item.createdAt <= now) &&
        devices.some(
          (device) =>
            device.user_id === item.userId &&
            allowed(item.workspaceId, device.session_id) &&
            (device.companyWorkspaceId === null || device.companyWorkspaceId === item.workspaceId),
        ),
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
        repeat_notification_id: item.repeat?.notificationId ?? null,
        record_id: item.recordId,
        workspace_id: item.workspaceId,
        user_id: item.userId,
        module: item.module,
        kind: item.kind,
        created_at: item.createdAt,
        expires_at: item.expiresAt,
        next_check_at: now,
        state: item.source === 'message' ? 'admitted' : 'pending',
      })),
    )
    .onConflict((conflict) => conflict.columns(['source_kind', 'source_id']).doNothing())
    .returning(['id', 'user_id', 'workspace_id'])
    .execute();
  const targets = inserted.flatMap((intent) =>
    devices
      .filter(
        (device) =>
          device.user_id === intent.user_id &&
          allowed(intent.workspace_id, device.session_id) &&
          (device.companyWorkspaceId === null || device.companyWorkspaceId === intent.workspace_id),
      )
      .map((device) => ({
        intent_id: intent.id,
        subscription_id: device.id,
        generation: device.generation,
        session_id: device.session_id,
        apns_session_id: device.apnsSessionId,
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
