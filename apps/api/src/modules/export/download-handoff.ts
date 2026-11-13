/** A claimed archive keeps its original authority; each external byte handoff rebuilds both live source fences. */
import { sql, type RawBuilder } from '@purlay/db';
import { AppError } from '../../platform/errors';
import {
  withinDeferredSource,
  type DeferredSourceDependencies,
} from '../../platform/deferred-source';
import { currentRequest } from '../../platform/logging';
import { activeWorkspaceMembership, requireWorkspaceMembership } from '../../platform/tenancy';
import { companySessionAllowsWorkspace } from '../../platform/company-session';
import type { WorkspaceAccessLifetime } from '../../platform/workspace-access-facts';
import { atomicallyOn } from '../../platform/transactions';
import { workspaceNativeDeadline } from '../../platform/workspace-access';
import { requireLegacyPersonalArchive, requirePreparedWorkspaceSet } from './source';

export type ArchiveDownloadHandoff = (dependencies: DeferredSourceDependencies) => Promise<void>;

/** Captures IDs and exact prepared scope only, never the transaction that claimed them. */
export const archiveDownloadHandoff = (input: {
  readonly kind: 'workspace' | 'personal';
  readonly exportId: string;
  readonly key: string;
  readonly userId: string;
  readonly callerSessionId: string | null;
  readonly sourceSessionId: string | null;
  readonly workspaceIds: readonly string[];
  readonly preparedWorkspaceIds?: readonly string[] | null;
}): ArchiveDownloadHandoff => {
  const claimed = Object.freeze({
    ...input,
    workspaceIds: [...input.workspaceIds],
    preparedWorkspaceIds:
      input.preparedWorkspaceIds === null || input.preparedWorkspaceIds === undefined
        ? input.preparedWorkspaceIds
        : [...input.preparedWorkspaceIds],
  });
  const legacy =
    claimed.kind === 'personal' &&
    (claimed.preparedWorkspaceIds === null || claimed.preparedWorkspaceIds === undefined);
  let captured:
    | {
        readonly predicate: RawBuilder<boolean>;
        readonly deadline: Date;
        readonly lifetime: WorkspaceAccessLifetime;
      }
    | undefined;
  const lifetimeOf = (dependencies: DeferredSourceDependencies): WorkspaceAccessLifetime =>
    dependencies.sessionLifetime?.() ?? { sessionIdleTimeoutHours: null, sessionMaxAgeDays: null };
  const unchangedLifetime = (a: WorkspaceAccessLifetime, b: WorkspaceAccessLifetime): boolean =>
    a.sessionIdleTimeoutHours === b.sessionIdleTimeoutHours &&
    a.sessionMaxAgeDays === b.sessionMaxAgeDays;
  const check = async (
    dependencies: DeferredSourceDependencies,
    permit: NonNullable<typeof captured>,
  ): Promise<void> => {
    if (!unchangedLifetime(permit.lifetime, lifetimeOf(dependencies)))
      throw new AppError({ code: 'EXPORT_NOT_FOUND', message: 'Export not found.' });
    const found = await dependencies.database
      .selectNoFrom(
        sql<boolean>`(${permit.predicate}
      and ${permit.deadline}::timestamptz > greatest(statement_timestamp(), ${dependencies.clock.now()}::timestamptz))`.as(
          'allowed',
        ),
      )
      .executeTakeFirst();
    if (found?.allowed !== true)
      throw new AppError({ code: 'EXPORT_NOT_FOUND', message: 'Export not found.' });
  };
  return async (dependencies): Promise<void> => {
    if (captured !== undefined) {
      await check(dependencies, captured);
      return;
    }
    const lifetime = { ...lifetimeOf(dependencies) };
    if (claimed.callerSessionId === null)
      throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
    const callerSessionId = claimed.callerSessionId;
    if (legacy) await requireLegacyPersonalArchive(dependencies.database);
    const permit = await atomicallyOn(dependencies.database)(async (transaction) => {
      // The native sources precede every workspace/user lock, including when source and downloader differ.
      const ids = [
        ...new Set([
          callerSessionId,
          ...(claimed.sourceSessionId === null ? [] : [claimed.sourceSessionId]),
        ]),
      ].sort();
      const sources = await transaction
        .selectFrom('sessions')
        .selectAll('sessions')
        .where('id', 'in', ids)
        .where('user_id', '=', claimed.userId)
        .orderBy('id')
        .forShare()
        .execute();
      if (sources.length !== ids.length)
        throw new AppError({ code: 'UNAUTHENTICATED', message: 'The archive session ended.' });
      if (claimed.workspaceIds.length > 0) {
        await transaction
          .selectFrom('workspaces')
          .select('id')
          .where('id', 'in', claimed.workspaceIds)
          .orderBy('id')
          .forShare()
          .execute();
      }
      await transaction
        .selectFrom('users')
        .select('id')
        .where('id', '=', claimed.userId)
        .forShare()
        .execute();
      if (claimed.workspaceIds.length > 0) {
        await transaction
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', 'in', claimed.workspaceIds)
          .where('user_id', '=', claimed.userId)
          .orderBy('workspace_id')
          .forShare()
          .execute();
      }
      const on = {
        ...dependencies,
        database: transaction,
        sessionLifetime: (): WorkspaceAccessLifetime => lifetime,
      };
      const authority = async (
        sessionId: string | null,
        caller: boolean,
      ): Promise<RawBuilder<boolean>> =>
        await withinDeferredSource(on, { userId: claimed.userId, sessionId }, async () => {
          if (claimed.kind === 'personal' && currentRequest()?.companySession !== undefined)
            throw new AppError({
              code: 'FORBIDDEN',
              message: 'Sign in independently to download account data.',
            });
          if (caller && claimed.kind === 'workspace') {
            const workspaceId = claimed.workspaceIds[0] ?? '';
            const member = await requireWorkspaceMembership(
              transaction,
              claimed.userId,
              workspaceId,
            );
            if (member.role !== 'owner' || member.guest !== undefined)
              throw new AppError({
                code: 'FORBIDDEN',
                message: 'Only a workspace owner can download its archive.',
              });
          }
          const prepared = await requirePreparedWorkspaceSet(
            transaction,
            claimed.userId,
            claimed.workspaceIds,
          );
          return claimed.workspaceIds.length === 0
            ? prepared
            : sql<boolean>`(${prepared} and not exists (
            select 1 from workspaces left join workspace_members
              on workspace_members.workspace_id = workspaces.id and workspace_members.user_id = ${claimed.userId}
            where workspaces.id in (${sql.join(claimed.workspaceIds)}) and workspaces.access_policy_epoch > 0
              and not coalesce(${activeWorkspaceMembership({ visibilityOnly: true })}, false)
          ))`;
        });
      const caller = await authority(callerSessionId, true);
      const original = await authority(claimed.sourceSessionId, false);
      const now = dependencies.clock.now();
      const caps =
        claimed.workspaceIds.length === 0
          ? []
          : await transaction
              .selectFrom('workspace_session_assurances as assurance')
              .innerJoin(
                'workspace_access_policies as policy',
                'policy.workspace_id',
                'assurance.workspace_id',
              )
              .innerJoin('workspaces', 'workspaces.id', 'assurance.workspace_id')
              .select([
                'assurance.expires_at',
                'assurance.mfa_expires_at',
                'policy.mode',
                'policy.require_mfa',
              ])
              .where('assurance.workspace_id', 'in', claimed.workspaceIds)
              .where('assurance.session_id', 'in', ids)
              .where('workspaces.access_policy_epoch', '>', '0')
              .execute();
      const deadline = Math.min(
        ...caps.flatMap((cap) => [
          new Date(cap.expires_at).getTime(),
          ...(cap.mode === 'enforced' && cap.require_mfa && cap.mfa_expires_at !== null
            ? [new Date(cap.mfa_expires_at).getTime()]
            : []),
        ]),
        ...sources.map((session) =>
          workspaceNativeDeadline(
            {
              sessionId: session.id,
              userId: claimed.userId,
              workspaceIds: claimed.workspaceIds,
              now,
              lifetime,
            },
            {
              session,
              evidence: undefined,
              membership: undefined,
              policy: undefined,
              assurance: undefined,
              workspaceFactor: undefined,
              globalFactor: undefined,
              companyProof: undefined,
            },
          ),
        ),
      );
      const source = sql<boolean>`download.source_session_id is not distinct from ${claimed.sourceSessionId}::uuid`;
      const identity =
        claimed.kind === 'workspace'
          ? sql<boolean>`exists (select 1 from workspace_exports as download
            where download.id = ${claimed.exportId} and download.requested_by = ${claimed.userId}
              and download.workspace_id = ${claimed.workspaceIds[0] ?? null}::uuid
              and download.status = 'downloaded' and download.storage_key = ${claimed.key} and ${source})`
          : sql<boolean>`exists (select 1 from personal_exports as download
            where download.id = ${claimed.exportId} and download.user_id = ${claimed.userId}
              and download.source_workspace_ids is not distinct from ${claimed.preparedWorkspaceIds ?? null}::uuid[]
              and ${legacy ? sql<boolean>`not exists (select 1 from workspaces where access_policy_epoch > 0)` : sql<boolean>`true`}
              and download.status = 'downloaded' and download.storage_key = ${claimed.key} and ${source})`;
      const native = sql<boolean>`(${sql.join(
        sources.map(
          (session) => sql<boolean>`exists (
        select 1 from sessions as native_source join users as native_user on native_user.id = native_source.user_id
        where native_source.id = ${session.id} and native_source.user_id = ${claimed.userId}
          and native_source.company_workspace_id is not distinct from ${session.company_workspace_id}::uuid
          and native_source.revoked_at is null and native_source.expires_at > statement_timestamp()
          and native_user.deleted_at is null and native_user.suspended_at is null
          and native_user.admission_state = 'approved'
          and (not native_user.admission_requires_verified_email or native_user.email_verified)
          and ${companySessionAllowsWorkspace('native_source', sql<string>`native_source.company_workspace_id`)}
      )`,
        ),
        sql` and `,
      )})`;
      const owner =
        claimed.kind === 'personal'
          ? sql<boolean>`true`
          : sql<boolean>`exists (
        select 1 from workspace_members as download_owner join workspaces as download_workspace
          on download_workspace.id = download_owner.workspace_id
        where download_owner.workspace_id = ${claimed.workspaceIds[0] ?? null}::uuid
          and download_owner.user_id = ${claimed.userId} and download_owner.role = 'owner'
          and download_owner.access_kind = 'member' and download_workspace.deleted_at is null
      )`;
      const value = {
        predicate: sql<boolean>`(${identity} and ${caller} and ${original} and ${native} and ${owner})`,
        deadline: new Date(deadline),
        lifetime,
      };
      await check(on, value);
      return value;
    });
    captured = Object.freeze(permit);
  };
};
