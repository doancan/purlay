/** Read-only native provenance for deferred output; this never bootstraps proof or records activity. */
import type { Executor } from '@purlay/db';
import type { Clock } from './clock';
import type { RequestScope } from './logging';
import {
  readWorkspacePolicyPreviewPage,
  type WorkspaceAccessLifetime,
} from './workspace-access-facts';
import { evaluateWorkspaceAccess, type WorkspaceAccessDecision } from './workspace-access';
import { workspaceAccessRequired } from './workspace-content-access';
import { requireWorkspaceSessionAccess } from './workspace-content-fence';

export interface WorkspaceNativeSource {
  readonly sessionId: string;
  readonly userId: string;
}
/** Every nested scope receives its original explicit source rather than inheriting ambient permission. */
export const readonlyWorkspaceAccess =
  (
    source: WorkspaceNativeSource,
    clock: Clock,
    lifetime: () => WorkspaceAccessLifetime,
  ): NonNullable<RequestScope['workspaceAccess']> =>
  async (executor, userId, workspaceId): Promise<void> => {
    if (userId !== source.userId) throw workspaceAccessRequired(workspaceId);
    await requireWorkspaceSessionAccess(executor, {
      sessionId: source.sessionId,
      userId,
      workspaceId,
      now: clock.now(),
      lifetime: lifetime(),
    });
  };

/** Actual source rows, at most 100 per chunk and eight indexed reads each, irrespective of recipient count. */
export const readWorkspaceSessionAccessDecisions = async (
  executor: Executor,
  input: {
    readonly workspaceId: string;
    readonly sessionIds: readonly string[];
    readonly now: Date;
    readonly lifetime: WorkspaceAccessLifetime;
  },
): Promise<ReadonlyMap<string, WorkspaceAccessDecision>> => {
  const ids = [...new Set(input.sessionIds)];
  const decisions = new Map<string, WorkspaceAccessDecision>();
  for (let start = 0; start < ids.length; start += 100) {
    const candidates = ids.slice(start, start + 100);
    const page = await readWorkspacePolicyPreviewPage(executor, {
      ...input,
      sessionIds: candidates,
      limit: 100,
    });
    for (const row of page.rows) {
      if (row.sessionId === null) continue;
      decisions.set(
        row.sessionId,
        evaluateWorkspaceAccess(
          {
            sessionId: row.sessionId,
            userId: row.userId,
            workspaceIds: [input.workspaceId],
            now: input.now,
            lifetime: input.lifetime,
          },
          input.workspaceId,
          row.facts,
        ),
      );
    }
  }
  return decisions;
};
