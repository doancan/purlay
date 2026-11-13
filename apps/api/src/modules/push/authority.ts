/** Current authority, not the snapshot which originally admitted a durable notification (#1405, #1312). */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { readGrants } from '../../platform/grants';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import type { PushNotices } from './notices';
import type { PushClaim } from './queue';
import { companySessionAllowsWorkspace } from '../../platform/company-session';
import { readWorkspaceSessionAccessDecisions } from '../../platform/workspace-delivery-access';
import type { WorkspaceAccessLifetime } from '../../platform/workspace-access-facts';
import { readonlyWorkspaceAccess } from '../../platform/workspace-delivery-access';
import { withinRequest } from '../../platform/logging';
import { AppError } from '../../platform/errors';

interface PushAuthority {
  readonly database: Executor;
  readonly clock: Clock;
  readonly notices: PushNotices;
  readonly effectiveModules: EntitlementPolicy['effective'];
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
}

export const currentPushDevice = async (
  {
    database,
    clock,
    sessionLifetime,
  }: Pick<PushAuthority, 'database' | 'clock' | 'sessionLifetime'>,
  claim: PushClaim,
): Promise<{ sound: boolean } | undefined> => {
  const device = await database
    .selectFrom('push_subscriptions as s')
    .innerJoin('sessions as live', 'live.id', 's.session_id')
    .innerJoin('users as person', 'person.id', 's.user_id')
    .innerJoin('workspaces as workspace', (join) => join.on('workspace.id', '=', claim.workspaceId))
    .select(['s.sound', 'workspace.access_policy_epoch'])
    .where('s.id', '=', claim.subscriptionId)
    .where('workspace.id', '=', claim.workspaceId)
    .where('s.user_id', '=', claim.userId)
    .where('s.session_id', '=', claim.sessionId)
    .where('s.generation', '=', claim.generation)
    .whereRef('live.user_id', '=', 's.user_id')
    .where('live.expires_at', '>', clock.now())
    .where(companySessionAllowsWorkspace('live', claim.workspaceId))
    .where('person.deleted_at', 'is', null)
    .where('person.suspended_at', 'is', null)
    .where('workspace.deleted_at', 'is', null)
    .executeTakeFirst();
  if (device === undefined) return undefined;
  if (device.access_policy_epoch !== '0') {
    if (sessionLifetime === undefined) return undefined;
    const access = await readWorkspaceSessionAccessDecisions(database, {
      workspaceId: claim.workspaceId,
      sessionIds: [claim.sessionId],
      now: clock.now(),
      lifetime: sessionLifetime(),
    });
    if (access.get(claim.sessionId)?.allowed !== true) return undefined;
  }
  return { sound: device.sound };
};

export const currentPushSource = async (
  dependencies: PushAuthority,
  claim: PushClaim,
): Promise<boolean> => {
  return await withinRequest(
    {
      requestId: `push:source:${claim.intentId}`,
      startedAt: performance.now(),
      sessionId: claim.sessionId,
      ...(dependencies.sessionLifetime === undefined
        ? {}
        : {
            workspaceAccess: readonlyWorkspaceAccess(
              { sessionId: claim.sessionId, userId: claim.userId },
              dependencies.clock,
              dependencies.sessionLifetime,
            ),
          }),
    },
    async () => {
      const { database, clock, notices, effectiveModules } = dependencies;
      const grants = await readGrants(database, [claim.workspaceId]);
      if (!effectiveModules(grants.get(claim.workspaceId) ?? [], clock.now()).has(claim.module))
        return false;
      if (claim.source === 'message')
        try {
          return await notices.canDeliver(database, claim.recordId, claim.userId, claim.sourceId);
        } catch (error) {
          if (error instanceof AppError && error.body.code === 'WORKSPACE_ACCESS_REQUIRED')
            return false;
          throw error;
        }
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
    },
  );
};
