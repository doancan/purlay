/** Cohort admission for already source-bound push candidates; never foreground activity. */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { WorkspaceAccessLifetime } from '../../platform/workspace-access-facts';
import { readWorkspaceSessionAccessDecisions } from '../../platform/workspace-delivery-access';

export const eligiblePushSources = async (
  dependencies: {
    readonly database: Executor;
    readonly clock: Clock;
    readonly sessionLifetime?: () => WorkspaceAccessLifetime;
  },
  epochs: ReadonlyMap<string, string>,
  candidates: readonly { readonly workspaceId: string; readonly sessionId: string }[],
): Promise<ReadonlySet<string>> => {
  const allowed = new Set<string>();
  const governed = new Map<string, Set<string>>();
  for (const row of candidates) {
    const epoch = epochs.get(row.workspaceId);
    if (epoch === '0') allowed.add(`${row.workspaceId}:${row.sessionId}`);
    else if (epoch !== undefined) {
      const ids = governed.get(row.workspaceId) ?? new Set<string>();
      ids.add(row.sessionId);
      governed.set(row.workspaceId, ids);
    }
  }
  if (dependencies.sessionLifetime !== undefined)
    for (const [workspaceId, sessionIds] of governed) {
      const decisions = await readWorkspaceSessionAccessDecisions(dependencies.database, {
        workspaceId,
        sessionIds: [...sessionIds],
        now: dependencies.clock.now(),
        lifetime: dependencies.sessionLifetime(),
      });
      for (const [id, decision] of decisions)
        if (decision.allowed) allowed.add(`${workspaceId}:${id}`);
    }
  return allowed;
};
