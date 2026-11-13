/** Workspace idle time moves only after an allowed foreground action in that exact workspace. */
import { evaluateWorkspaceAccess, workspaceBaseDeadline } from '../../../platform/workspace-access';
import { readWorkspaceAccessFacts } from '../../../platform/workspace-access-facts';
import { atomicallyOn } from '../../../platform/transactions';
import { workspaceAccessRequired } from '../../../platform/workspace-content-access';
import {
  lockWorkspaceSecurityActor,
  type WorkspaceSecurityActor,
  type WorkspaceSecurityDependencies,
} from './authority';

const ACTIVITY_STALE_MS = 60_000;

export const recordWorkspaceActivity = async (
  dependencies: Pick<WorkspaceSecurityDependencies, 'database' | 'clock' | 'lifetime'>,
  actor: WorkspaceSecurityActor,
): Promise<void> => {
  await atomicallyOn(dependencies.database)(async (transaction) => {
    await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'self');
    const now = dependencies.clock.now();
    const input = {
      sessionId: actor.sessionId,
      userId: actor.context.userId,
      workspaceIds: [actor.context.workspaceId],
      now,
      lifetime: dependencies.lifetime(),
    };
    const facts = (await readWorkspaceAccessFacts(transaction, input)).get(
      actor.context.workspaceId,
    );
    if (facts === undefined) throw workspaceAccessRequired(actor.context.workspaceId);
    const decision = evaluateWorkspaceAccess(input, actor.context.workspaceId, facts);
    if (!decision.allowed) throw workspaceAccessRequired(actor.context.workspaceId);
    const old = facts.assurance;
    if (
      old === undefined ||
      now.getTime() - new Date(old.last_used_at).getTime() < ACTIVITY_STALE_MS
    )
      return;
    const oldDeadline = new Date(old.expires_at).getTime();
    const naturalDeadline = workspaceBaseDeadline(input, facts);
    const nextDeadline = workspaceBaseDeadline(input, {
      ...facts,
      assurance: { ...old, last_used_at: now },
    });
    // A retained earlier cap (handoff or a tighter prior policy) is not reclassified as renewable idle time.
    const expiresAt = new Date(
      oldDeadline === naturalDeadline ? nextDeadline : Math.min(oldDeadline, nextDeadline),
    );
    await transaction
      .updateTable('workspace_session_assurances')
      .set({ last_used_at: now, expires_at: expiresAt, updated_at: now })
      .where('workspace_id', '=', actor.context.workspaceId)
      .where('session_id', '=', actor.sessionId)
      .where('user_id', '=', actor.context.userId)
      .where('authentication_revision', '=', old.authentication_revision)
      .where('policy_epoch', '=', old.policy_epoch)
      .where('policy_revision', old.policy_revision === null ? 'is' : '=', old.policy_revision)
      .where('ended_at', 'is', null)
      .where('expires_at', '>', now)
      .where('last_used_at', '=', old.last_used_at)
      .execute();
  });
};
