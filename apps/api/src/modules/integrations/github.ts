/**
 * The workspace's GitHub credential (D-11, D-23, #65): **one per workspace, never per user** — a
 * member's own token would leak which private repositories they can see through whether a card
 * renders. Sealed by the one cipher (`platform/crypto.ts`, D-39 §6) with the row's id bound in, so
 * the id is given here before the seal, and a replacement keeps its row. Never returned, never
 * logged, never in the audit trail: what is recorded is that it was set or removed, and by whom.
 *
 * Seeing whether it is set, setting it and removing it are an owner's or an admin's (§7.4: the
 * GitHub integration is configured by them).
 *
 * Two things more are known of it, from GitHub (D-23, amended; #884): when GitHub first refused it
 * (`token_invalid_at`, set by the unfurl, cleared by a replacement or a removal), and the scopes a
 * classic token had when it was saved (`token_scopes`), which say whether it is broader than a card needs.
 */
import type { Executor } from '@purlay/db';
import type { GitHubIntegration } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { SealBroken, type CredentialCipher } from '../../platform/crypto';
import type { Logger } from '../../platform/logging';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import { recordAudit } from '../audit/audit';

export const mayConfigure = (context: WorkspaceContext): void => {
  if (context.role === 'member') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin configures the GitHub integration.',
    });
  }
};

/**
 * Whether a classic token's scopes are more than cards need: `repo`, or any scope that writes. A
 * fine-grained token has no scopes to read (`null`) and is what is asked for. Whole names, since a
 * prefix such as `repo:status` is read-only.
 */
export const broadScopes = (scopes: string | null): boolean =>
  scopes
    ?.split(',')
    .map((scope) => scope.trim())
    .some((scope) => /^(repo|workflow|delete_repo|(admin|write):.+)$/.test(scope)) ?? false;

export const githubIntegrationOf = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<GitHubIntegration> => {
  mayConfigure(context);
  const row = await executor
    .selectFrom('github_integrations')
    .select(['access_token_encrypted', 'updated_at', 'token_invalid_at', 'token_scopes'])
    .where('workspace_id', '=', context.workspaceId)
    .executeTakeFirst();
  return row?.access_token_encrypted == null
    ? { configured: false, updatedAt: null, invalidSince: null, broadScopes: false }
    : {
        configured: true,
        updatedAt: new Date(row.updated_at).toISOString(),
        invalidSince:
          row.token_invalid_at === null ? null : new Date(row.token_invalid_at).toISOString(),
        broadScopes: broadScopes(row.token_scopes),
      };
};

/**
 * Inside the caller's transaction: the row is locked, so two admins setting it at once take turns.
 * `scopes` is what GitHub said of the token when it was checked (`TokenCheck`); a replacement clears
 * what was known of the one before it.
 */
export const setGitHubToken = async (
  executor: Executor,
  clock: Clock,
  cipher: CredentialCipher,
  context: WorkspaceContext,
  token: string,
  scopes: string | null = null,
): Promise<void> => {
  mayConfigure(context);
  const existing = await executor
    .selectFrom('github_integrations')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  const id = existing?.id ?? crypto.randomUUID();
  const sealed = Buffer.from(await cipher.seal(token, id)).toString('base64');
  const now = clock.now();
  await executor
    .insertInto('github_integrations')
    .values({
      id,
      workspace_id: context.workspaceId,
      access_token_encrypted: sealed,
      token_scopes: scopes,
      created_by: context.userId,
      created_at: now,
      updated_at: now,
    })
    .onConflict((conflict) =>
      conflict.column('workspace_id').doUpdateSet({
        access_token_encrypted: sealed,
        token_invalid_at: null,
        token_scopes: scopes,
        updated_at: now,
      }),
    )
    .execute();
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.token_set',
    targetType: 'integration',
    targetId: id,
  });
};

/** Removes the token, keeping the row; removing one that is not there records nothing. */
export const removeGitHubToken = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
): Promise<void> => {
  mayConfigure(context);
  const removed = await executor
    .updateTable('github_integrations')
    .set({
      access_token_encrypted: null,
      token_invalid_at: null,
      token_scopes: null,
      updated_at: clock.now(),
    })
    .where('workspace_id', '=', context.workspaceId)
    .where('access_token_encrypted', 'is not', null)
    .returning('id')
    .executeTakeFirst();
  if (removed === undefined) return;
  await recordAudit(executor, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'integration.token_removed',
    targetType: 'integration',
    targetId: removed.id,
  });
};

/**
 * The workspace's token in the clear, for the one request it is for (#66); null when none is set.
 * One that does not open — `ENCRYPTION_KEY` was changed, or the row was altered — is said, loudly,
 * and is no token: the card is not drawn, and the operator is told why.
 */
export const githubTokenOf = async (
  executor: Executor,
  cipher: CredentialCipher,
  log: Logger,
  context: WorkspaceContext,
): Promise<string | null> => {
  const row = await executor
    .selectFrom('github_integrations')
    .select(['id', 'access_token_encrypted'])
    .where('workspace_id', '=', context.workspaceId)
    .executeTakeFirst();
  if (row?.access_token_encrypted == null) return null;
  try {
    return await cipher.open(Buffer.from(row.access_token_encrypted, 'base64'), row.id);
  } catch (error) {
    if (!(error instanceof SealBroken)) throw error;
    log.error('the workspace’s GitHub token does not open: was ENCRYPTION_KEY changed?', {
      workspaceId: context.workspaceId,
    });
    return null;
  }
};
