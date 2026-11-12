/** Current authority, not the snapshot which originally admitted a durable notification (#1405, #1312). */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { readGrants } from '../../platform/grants';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import type { PushNotices } from './notices';
import type { PushClaim } from './queue';

interface PushAuthority {
  readonly database: Executor;
  readonly clock: Clock;
  readonly notices: PushNotices;
  readonly effectiveModules: EntitlementPolicy['effective'];
}

export const currentPushDevice = async (
  { database, clock }: Pick<PushAuthority, 'database' | 'clock'>,
  claim: PushClaim,
): Promise<{ sound: boolean } | undefined> =>
  await database
    .selectFrom('push_subscriptions as s')
    .innerJoin('sessions as live', 'live.id', 's.session_id')
    .innerJoin('users as person', 'person.id', 's.user_id')
    .select('s.sound')
    .where('s.id', '=', claim.subscriptionId)
    .where('s.user_id', '=', claim.userId)
    .where('s.session_id', '=', claim.sessionId)
    .where('s.generation', '=', claim.generation)
    .whereRef('live.user_id', '=', 's.user_id')
    .where('live.expires_at', '>', clock.now())
    .where('person.deleted_at', 'is', null)
    .where('person.suspended_at', 'is', null)
    .executeTakeFirst();

export const currentPushSource = async (
  dependencies: PushAuthority,
  claim: PushClaim,
): Promise<boolean> => {
  const { database, clock, notices, effectiveModules } = dependencies;
  const grants = await readGrants(database, [claim.workspaceId]);
  if (!effectiveModules(grants.get(claim.workspaceId) ?? [], clock.now()).has(claim.module))
    return false;
  if (claim.source === 'message')
    return await notices.canDeliver(database, claim.recordId, claim.userId, claim.sourceId);
  return (
    (await database
      .selectFrom('inbox_entries as e')
      .innerJoin('workspace_members as member', (join) =>
        join
          .onRef('member.workspace_id', '=', 'e.workspace_id')
          .onRef('member.user_id', '=', 'e.user_id')
          .on('member.access_kind', '=', 'member'),
      )
      .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
      .innerJoin('users as person', 'person.id', 'e.user_id')
      .select('e.id')
      .where('e.id', '=', claim.recordId)
      .where('e.id', '=', claim.sourceId)
      .where('e.workspace_id', '=', claim.workspaceId)
      .where('e.user_id', '=', claim.userId)
      .where('e.module', '=', claim.module)
      .where('e.kind', '=', claim.kind)
      .where('e.read_at', 'is', null)
      .where('w.deleted_at', 'is', null)
      .where('person.deleted_at', 'is', null)
      .where('person.suspended_at', 'is', null)
      .executeTakeFirst()) !== undefined
  );
};
