/** Retain tighter deadlines for inactive proofs before changing policy; relaxation cannot resurrect them later. */
import { sql, type Transaction } from '@purlay/db';
import type { WorkspacePolicySettings } from '@purlay/types/workspace-security';
import {
  evaluateWorkspacePolicyProposal,
  workspaceNativeMfaEvent,
  workspacePrimaryConsistent,
} from '../../../platform/workspace-access';
import {
  readWorkspacePolicyPreviewPage,
  type WorkspacePolicyPreviewCursor,
} from '../../../platform/workspace-access-facts';
import type { WorkspacePolicyDependencies } from './policy-authority';
import { securityChanged } from './authority';

export const retainWorkspacePolicyDeadlines = async (
  transaction: Transaction,
  dependencies: WorkspacePolicyDependencies,
  workspaceId: string,
  settings: WorkspacePolicySettings,
): Promise<void> => {
  if (settings.mode !== 'enforced') return;
  const now = dependencies.clock.now();
  let after: WorkspacePolicyPreviewCursor | undefined;
  for (;;) {
    const page = await readWorkspacePolicyPreviewPage(transaction, {
      workspaceId,
      limit: 100,
      now,
      lifetime: dependencies.lifetime(),
      ...(after === undefined ? {} : { after }),
    });
    const projected = page.rows.flatMap((row) => {
      const old = row.facts.assurance;
      const ended = old?.ended_at;
      if (
        row.sessionId === null ||
        (ended !== undefined && ended !== null) ||
        !workspacePrimaryConsistent(row.facts)
      )
        return [];
      const input = {
        sessionId: row.sessionId,
        userId: row.userId,
        workspaceIds: [workspaceId],
        now,
        lifetime: dependencies.lifetime(),
      };
      const decision = evaluateWorkspacePolicyProposal(input, workspaceId, row.facts, settings);
      if (decision.baseExpiresAt === null) return [];
      return [
        {
          session: row.sessionId,
          user: row.userId,
          authentication: row.facts.evidence?.revision ?? '',
          base: decision.baseExpiresAt,
          mfa: decision.mfaExpiresAt,
          old,
          facts: row.facts,
          nativeMfa: workspaceNativeMfaEvent(input, row.facts),
        },
      ];
    });
    const missing = projected.filter((row) => row.old === undefined);
    if (projected.length > 0) {
      // The workspace is already locked. Never wait on a source/FK parent held by a revoker that may need it next.
      const ids = projected.map((row) => row.session);
      const sources = await transaction
        .selectFrom('sessions')
        .select(['id', 'user_id'])
        .where('id', 'in', ids)
        .orderBy('id')
        .forKeyShare()
        .skipLocked()
        .execute();
      const evidence = await transaction
        .selectFrom('session_authentication_evidence')
        .select(['session_id', 'user_id', 'revision'])
        .where('session_id', 'in', ids)
        .orderBy('session_id')
        .forKeyShare()
        .skipLocked()
        .execute();
      const users = [...new Set(projected.map((row) => row.user))];
      const members = await transaction
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', workspaceId)
        .where('user_id', 'in', users)
        .orderBy('user_id')
        .forKeyShare()
        .skipLocked()
        .execute();
      const sourceById = new Map(sources.map((row) => [row.id, row]));
      const proofById = new Map(evidence.map((row) => [row.session_id, row]));
      if (
        members.length !== users.length ||
        projected.some(
          (row) =>
            sourceById.get(row.session)?.user_id !== row.user ||
            proofById.get(row.session)?.user_id !== row.user ||
            proofById.get(row.session)?.revision !== row.authentication,
        )
      )
        throw securityChanged();
    }
    if (missing.length > 0)
      await transaction
        .insertInto('workspace_session_assurances')
        .values(
          missing.map((row) => {
            const native =
              row.nativeMfa !== undefined &&
              row.mfa !== null &&
              row.facts.globalFactor !== undefined;
            return {
              workspace_id: workspaceId,
              session_id: row.session,
              user_id: row.user,
              authentication_revision: row.authentication,
              policy_revision: row.facts.policy?.revision ?? null,
              policy_epoch: row.facts.membership?.epoch ?? '0',
              expires_at: row.base,
              last_used_at: new Date(Math.min(now.getTime(), row.base.getTime() - 1)),
              ended_at: row.base.getTime() <= now.getTime() ? now : null,
              end_reason: row.base.getTime() <= now.getTime() ? 'expired' : null,
              factor_scope: native ? 'global' : null,
              factor_id: native ? (row.facts.globalFactor?.id ?? null) : null,
              factor_revision: native ? (row.facts.globalFactor?.assurance_revision ?? null) : null,
              mfa_verified_at: native ? (row.nativeMfa ?? null) : null,
              mfa_expires_at: native ? row.mfa : null,
              created_at: now,
              updated_at: now,
            };
          }),
        )
        .onConflict((conflict) => conflict.columns(['workspace_id', 'session_id']).doNothing())
        .execute();
    const rows = projected.filter((row) => row.old !== undefined);
    if (rows.length > 0)
      await sql`update workspace_session_assurances as assurance set
      expires_at = case when limits.base <= assurance.last_used_at then assurance.expires_at else least(assurance.expires_at, limits.base) end,
      mfa_expires_at = case when assurance.factor_scope is null or limits.mfa is null then assurance.mfa_expires_at
        else least(assurance.mfa_expires_at, limits.mfa) end,
      ended_at = case when limits.base <= ${now} or limits.base <= assurance.last_used_at then ${now} else assurance.ended_at end,
      end_reason = case when limits.base <= ${now} or limits.base <= assurance.last_used_at then 'expired' else assurance.end_reason end,
      updated_at = ${now}
      from (values ${sql.join(rows.map((row) => sql`(${row.session}::uuid, ${row.user}::uuid, ${row.authentication}::uuid, ${row.base}::timestamptz, ${row.mfa}::timestamptz)`))})
        as limits(session_id, user_id, authentication_revision, base, mfa)
      where assurance.workspace_id = ${workspaceId}::uuid and assurance.session_id = limits.session_id
        and assurance.user_id = limits.user_id and assurance.authentication_revision = limits.authentication_revision
        and assurance.ended_at is null`.execute(transaction);
    if (page.next === null) return;
    after = page.next;
  }
};
