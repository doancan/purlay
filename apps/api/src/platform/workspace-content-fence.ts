/** A final SQL fence binds a shared access decision to the exact native, policy and factor facts it observed. */
import { sql, type Executor, type RawBuilder } from '@purlay/db';
import { companySessionAllowsWorkspace } from './company-session';
import { currentRequest } from './logging';
import {
  evaluateWorkspaceAccess,
  type WorkspaceAccessRead,
  type WorkspaceAccessDecision,
} from './workspace-access';
import { readWorkspacePolicyPreviewPage } from './workspace-policy-preview';
import { readWorkspaceAccessFacts, type WorkspaceAccessFacts } from './workspace-access-facts';
import { workspaceAccessRequired } from './workspace-content-access';

const proof: unique symbol = Symbol('WorkspaceContentFence');
const minted = new WeakSet<object>();
export interface WorkspaceContentFence {
  readonly userId: string;
  readonly workspaceId: string;
  readonly predicate: RawBuilder<boolean>;
  readonly [proof]: true;
}

const assuranceFence = (
  input: WorkspaceAccessRead,
  facts: WorkspaceAccessFacts,
  workspaceId: string,
): RawBuilder<boolean> => {
  const row = facts.assurance;
  if (row === undefined)
    return sql<boolean>`not exists (
      select 1 from workspace_session_assurances as final_assurance
      where final_assurance.workspace_id = ${workspaceId} and final_assurance.session_id = ${input.sessionId}
    )`;
  const mfa = facts.policy?.mode === 'enforced' && facts.policy.require_mfa;
  const factor = !mfa
    ? sql<boolean>`true`
    : row.factor_scope === 'workspace'
      ? sql<boolean>`exists (
          select 1 from workspace_mfa_factors as final_factor
          where final_factor.workspace_id = ${workspaceId} and final_factor.user_id = ${input.userId}
            and final_factor.id = ${row.factor_id} and final_factor.revision = ${row.factor_revision}
            and final_factor.state = 'verified' and final_factor.revoked_at is null
        )`
      : sql<boolean>`exists (
          select 1 from two_factors as final_factor
          where final_factor.user_id = ${input.userId} and final_factor.id = ${row.factor_id}
            and final_factor.assurance_revision = ${row.factor_revision} and final_factor.verified
        )`;
  return sql<boolean>`exists (
    select 1 from workspace_session_assurances as final_assurance
    where final_assurance.workspace_id = ${workspaceId} and final_assurance.session_id = ${input.sessionId}
      and final_assurance.user_id = ${input.userId}
      and final_assurance.authentication_revision = ${row.authentication_revision}
      and final_assurance.policy_epoch = ${row.policy_epoch}
      and final_assurance.policy_revision is not distinct from ${row.policy_revision}::uuid
      and final_assurance.ended_at is null
      and final_assurance.expires_at > greatest(statement_timestamp(), ${input.now}::timestamptz)
      and ${
        !mfa
          ? sql<boolean>`true`
          : sql<boolean>`(
        final_assurance.factor_scope = ${row.factor_scope}
        and final_assurance.factor_id = ${row.factor_id}
        and final_assurance.factor_revision = ${row.factor_revision}
        and final_assurance.mfa_verified_at = ${row.mfa_verified_at}
        and final_assurance.mfa_expires_at > greatest(statement_timestamp(), ${input.now}::timestamptz)
        and ${factor}
      )`
      }
  )`;
};

type WorkspaceContentInput = Omit<WorkspaceAccessRead, 'workspaceIds'> & {
  readonly workspaceId: string;
};

/** Only actual SQL readers in this module can create a captured native authority. */
const captureWorkspaceSessionAccess = (
  input: WorkspaceContentInput,
  facts: WorkspaceAccessFacts | undefined,
): void => {
  const read = { ...input, workspaceIds: [input.workspaceId] };
  if (facts === undefined) throw workspaceAccessRequired(input.workspaceId);
  const decision = evaluateWorkspaceAccess(read, input.workspaceId, facts);
  if (!decision.allowed) throw workspaceAccessRequired(input.workspaceId);
  if (facts.membership?.epoch === '0') return;
  const session = facts.session;
  const policy = facts.policy;
  const scope = currentRequest();
  const deadline = decision.status.expiresAt;
  if (session === undefined || policy === undefined || deadline === null)
    throw workspaceAccessRequired(input.workspaceId);
  if (scope?.sessionId !== input.sessionId) throw workspaceAccessRequired(input.workspaceId);
  const evidence = facts.evidence;
  const primary =
    evidence === undefined
      ? sql<boolean>`not exists (select 1 from session_authentication_evidence as final_evidence where final_evidence.session_id = ${input.sessionId})`
      : sql<boolean>`exists (select 1 from session_authentication_evidence as final_evidence
        where final_evidence.session_id = ${input.sessionId} and final_evidence.user_id = ${input.userId}
          and final_evidence.revision = ${evidence.revision})`;
  const predicate = sql<boolean>`(
    workspace_members.workspace_id = ${input.workspaceId}
    and workspaces.access_policy_epoch = ${facts.membership?.epoch}
    and ${deadline}::timestamptz > greatest(statement_timestamp(), ${input.now}::timestamptz)
    and exists (select 1 from workspace_access_policies as final_policy
      where final_policy.workspace_id = ${input.workspaceId} and final_policy.epoch = ${policy.epoch}
        and final_policy.revision = ${policy.revision})
    and exists (
      select 1 from sessions as final_session join users as final_user on final_user.id = final_session.user_id
      where final_session.id = ${input.sessionId} and final_session.user_id = ${input.userId}
        and final_session.company_workspace_id is not distinct from ${session.company_workspace_id}::uuid
        and final_session.revoked_at is null
        and final_session.expires_at > greatest(statement_timestamp(), ${input.now}::timestamptz)
        and final_user.deleted_at is null and final_user.suspended_at is null
        and final_user.admission_state = 'approved'
        and (not final_user.admission_requires_verified_email or final_user.email_verified)
        and ${session.company_workspace_id === null ? sql<boolean>`true` : companySessionAllowsWorkspace('final_session', input.workspaceId, { member: 'workspace_members', person: 'final_user', workspace: 'workspaces' })}
    ) and ${primary} and ${assuranceFence(read, facts, input.workspaceId)}
  )`;
  scope.workspaceFences ??= new Map();
  const fence: WorkspaceContentFence = Object.freeze({
    userId: input.userId,
    workspaceId: input.workspaceId,
    predicate,
    [proof]: true as const,
  });
  minted.add(fence);
  scope.workspaceFences.set(input.workspaceId, fence);
};

export const requireWorkspaceSessionAccess = async (
  executor: Executor,
  input: WorkspaceContentInput,
): Promise<void> => {
  const facts = (
    await readWorkspaceAccessFacts(executor, { ...input, workspaceIds: [input.workspaceId] })
  ).get(input.workspaceId);
  captureWorkspaceSessionAccess(input, facts);
};

export interface WorkspaceContentPermit {
  readonly userId: string;
  readonly decision: WorkspaceAccessDecision;
  /** Installs only this closure's actual native facts in the matching request; final SQL still fences them. */
  readonly capture: (now: Date) => void;
}

/** No public plain-facts constructor: all cohort permits originate in the canonical SQL factual loader. */
export const readWorkspaceContentPermits = async (
  executor: Executor,
  input: {
    readonly workspaceId: string;
    readonly sessionIds: readonly string[];
    readonly now: Date;
    readonly lifetime: WorkspaceAccessRead['lifetime'];
  },
): Promise<ReadonlyMap<string, WorkspaceContentPermit>> => {
  const ids = [...new Set(input.sessionIds)];
  const permits = new Map<string, WorkspaceContentPermit>();
  for (let start = 0; start < ids.length; start += 100) {
    const page = await readWorkspacePolicyPreviewPage(executor, {
      ...input,
      sessionIds: ids.slice(start, start + 100),
      limit: 100,
    });
    for (const row of page.rows) {
      if (row.sessionId === null) continue;
      const native = {
        sessionId: row.sessionId,
        userId: row.userId,
        workspaceId: input.workspaceId,
        now: input.now,
        lifetime: input.lifetime,
      };
      const decision = evaluateWorkspaceAccess(
        { ...native, workspaceIds: [input.workspaceId] },
        input.workspaceId,
        row.facts,
      );
      const loadedAt = input.now.getTime();
      permits.set(
        row.sessionId,
        Object.freeze({
          userId: row.userId,
          decision,
          capture: (now: Date): void => {
            const scope = currentRequest();
            if (
              !Number.isFinite(now.getTime()) ||
              now.getTime() < loadedAt ||
              scope?.sessionId !== native.sessionId ||
              (scope.companySession !== undefined && scope.companySession.userId !== native.userId)
            )
              throw workspaceAccessRequired(input.workspaceId);
            captureWorkspaceSessionAccess({ ...native, now }, row.facts);
          },
        }),
      );
    }
  }
  return permits;
};

/** This only preserves a previously evaluated decision; it never creates authority or evaluates policy itself. */
export const currentWorkspaceContentFence = (): RawBuilder<boolean> => {
  const fences = [...(currentRequest()?.workspaceFences?.values() ?? [])];
  if (fences.some((fence) => !minted.has(fence)))
    throw new Error('A copied workspace content fence was refused');
  const first = fences[0];
  if (first === undefined) return sql<boolean>`workspaces.access_policy_epoch = 0`;
  return sql<boolean>`(
    workspace_members.user_id <> ${first.userId} or workspaces.access_policy_epoch = 0
    or ${sql.join(
      fences.map((fence) => fence.predicate),
      sql` or `,
    )}
  )`;
};
