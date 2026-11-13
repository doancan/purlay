/** HTTP carries a proved native SID; foreground activity is an optional hint, never admission authority. */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { currentRequest, type RequestScope } from '../../platform/logging';
import { requireWorkspaceSecurityMembership } from '../../platform/tenancy';
import { workspaceAccessRequired } from '../../platform/workspace-content-access';
import { requireWorkspaceSessionAccess } from '../../platform/workspace-content-fence';
import { recordWorkspaceActivity } from '../../modules/workspaces/security/activity';
import type { Auth } from '../../modules/auth/better-auth';

export const workspaceHttpAccess =
  (
    dependencies: { readonly auth: Pick<Auth, 'sessionLifetime'>; readonly clock: Clock },
    request: Request,
  ): NonNullable<RequestScope['workspaceAccess']> =>
  async (executor: Executor, userId: string, workspaceId: string): Promise<void> => {
    const scope = currentRequest();
    if (scope?.sessionId === undefined) throw workspaceAccessRequired(workspaceId);
    const sessionId = scope.sessionId;
    await requireWorkspaceSessionAccess(executor, {
      sessionId,
      userId,
      workspaceId,
      now: dependencies.clock.now(),
      lifetime: dependencies.auth.sessionLifetime,
    });
    if (request.headers.get('x-purlay-active-workspace') !== workspaceId) return;
    scope.workspaceActivity ??= new Map();
    scope.workspaceActivity.set(workspaceId, async (): Promise<void> => {
      const context = await requireWorkspaceSecurityMembership(executor, userId, workspaceId);
      await recordWorkspaceActivity(
        {
          database: executor,
          clock: dependencies.clock,
          lifetime: () => dependencies.auth.sessionLifetime,
        },
        { context, sessionId },
      );
    });
  };
