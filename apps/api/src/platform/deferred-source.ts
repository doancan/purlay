/** Persisted native provenance is retained through jobs; background work never borrows an ambient user. */
import { isTransaction, sql, type Executor } from '@purlay/db';
import type { Clock } from './clock';
import { companySessionAllowsWorkspace } from './company-session';
import { AppError } from './errors';
import { currentRequest, withinRequest } from './logging';
import type { WorkspaceAccessFacts, WorkspaceAccessLifetime } from './workspace-access-facts';
import { workspaceNativeDeadline } from './workspace-access';
import { readonlyWorkspaceAccess } from './workspace-delivery-access';

export interface DeferredSourceDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
}
export const withinDeferredSource = async <T>(
  dependencies: DeferredSourceDependencies,
  source: { readonly userId: string; readonly sessionId: string | null },
  work: () => Promise<T>,
): Promise<T> => {
  const ambient = currentRequest();
  let companyWorkspaceId: string | null = null;
  if (source.sessionId !== null) {
    let query = dependencies.database
      .selectFrom('sessions')
      .innerJoin('users', 'users.id', 'sessions.user_id')
      .selectAll('sessions')
      .where('sessions.id', '=', source.sessionId)
      .where('sessions.user_id', '=', source.userId)
      .where('sessions.revoked_at', 'is', null)
      .where('users.deleted_at', 'is', null)
      .where('users.suspended_at', 'is', null)
      .where('users.admission_state', '=', 'approved')
      .where((eb) =>
        eb.or([
          eb('users.admission_requires_verified_email', '=', false),
          eb('users.email_verified', '=', true),
        ]),
      )
      .where(companySessionAllowsWorkspace('sessions', sql<string>`sessions.company_workspace_id`));
    if (isTransaction(dependencies.database)) query = query.forShare(['sessions']);
    const session = await query.executeTakeFirst();
    const facts: WorkspaceAccessFacts = {
      session,
      evidence: undefined,
      membership: undefined,
      policy: undefined,
      assurance: undefined,
      workspaceFactor: undefined,
      globalFactor: undefined,
      companyProof: undefined,
    };
    const now = dependencies.clock.now();
    const end = workspaceNativeDeadline(
      {
        sessionId: source.sessionId,
        userId: source.userId,
        workspaceIds: [],
        now,
        lifetime: dependencies.sessionLifetime?.() ?? {
          sessionIdleTimeoutHours: null,
          sessionMaxAgeDays: null,
        },
      },
      facts,
    );
    if (session === undefined || !Number.isFinite(end) || end <= now.getTime())
      throw new AppError({ code: 'UNAUTHENTICATED', message: 'The original job session ended.' });
    companyWorkspaceId = session.company_workspace_id;
  }
  return await withinRequest(
    {
      requestId: `deferred:${crypto.randomUUID()}`,
      startedAt: performance.now(),
      ...(ambient?.module === undefined ? {} : { module: ambient.module }),
      ...(ambient?.signal === undefined ? {} : { signal: ambient.signal }),
      ...(source.sessionId === null ? {} : { sessionId: source.sessionId }),
      ...(companyWorkspaceId === null
        ? {}
        : { companySession: { userId: source.userId, workspaceId: companyWorkspaceId } }),
      ...(source.sessionId === null || dependencies.sessionLifetime === undefined
        ? {}
        : {
            workspaceAccess: readonlyWorkspaceAccess(
              { sessionId: source.sessionId, userId: source.userId },
              dependencies.clock,
              dependencies.sessionLifetime,
            ),
          }),
    },
    work,
  );
};
