/** Audited changes to server authority. Always called inside the caller's transaction. */
import { sql, type Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { recordServerAudit } from '../audit/server-audit';
import { revokeAllSessions } from '../auth/sessions';
import { operateQuota } from '../attachments/quota';
import type { ServerAdminSession } from '../setup/setup';
import {
  applyEntitlements,
  type EntitlementCatalogue,
  type EntitlementWrite,
} from '../entitlements/apply';

/** All authority changes use this lock first, then recheck the actor, before locking a target. */
export const serializeServerAdministrators = async (tx: Transaction): Promise<void> => {
  await sql`select pg_advisory_xact_lock(hashtextextended('purlay.server-administrators', 0))`.execute(
    tx,
  );
};

export const lockServerAdministrator = async (
  tx: Transaction,
  admin: ServerAdminSession,
): Promise<void> => {
  await serializeServerAdministrators(tx);
  const actor = await tx
    .selectFrom('users')
    .select('id')
    .where('id', '=', admin.userId)
    .where('is_server_admin', '=', true)
    .where('deleted_at', 'is', null)
    .where('suspended_at', 'is', null)
    .forShare()
    .executeTakeFirst();
  if (actor === undefined)
    throw new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
};

export const changeServerAdministrator = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  userId: string,
  granted: boolean,
): Promise<void> => {
  await lockServerAdministrator(tx, admin);
  const user = await tx
    .selectFrom('users')
    .select(['id', 'is_server_admin', 'suspended_at', 'email_verified', 'admission_state'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (user === undefined)
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'No such account.' });
  if (user.is_server_admin === granted) return;
  if (
    granted &&
    (user.suspended_at !== null || !user.email_verified || user.admission_state !== 'approved')
  ) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an active account with a verified email can administer the server.',
    });
  }
  if (!granted) {
    const others = await tx
      .selectFrom('users')
      .select('id')
      .where('id', '!=', userId)
      .where('is_server_admin', '=', true)
      .where('deleted_at', 'is', null)
      .where('suspended_at', 'is', null)
      .limit(1)
      .execute();
    if (others.length === 0)
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'The server must keep at least one active administrator.',
      });
  }
  await tx
    .updateTable('users')
    .set({ is_server_admin: granted, updated_at: clock.now() })
    .where('id', '=', userId)
    .execute();
  await recordServerAudit(tx, clock, {
    actorUserId: admin.userId,
    action: granted ? 'server.admin_granted' : 'server.admin_revoked',
    targetUserId: userId,
  });
};

export const revokeServerUserSessions = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  userId: string,
): Promise<readonly string[]> => {
  await lockServerAdministrator(tx, admin);
  await tx
    .selectFrom('sessions')
    .select('id')
    .where('user_id', '=', userId)
    .orderBy('id')
    .forUpdate()
    .execute();
  const user = await tx
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (user === undefined)
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'No such account.' });
  const ended = await revokeAllSessions(tx, userId);
  await recordServerAudit(tx, clock, {
    actorUserId: admin.userId,
    action: 'server.sessions_revoked',
    targetUserId: userId,
  });
  return ended;
};

export const changeServerQuota = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  workspaceId: string,
  quotaBytes: number,
): Promise<void> => {
  await lockServerAdministrator(tx, admin);
  const workspace = await tx
    .selectFrom('workspaces')
    .select(['slug', 'storage_quota_bytes'])
    .where('id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  if (workspace === undefined)
    throw new AppError({ code: 'WORKSPACE_NOT_FOUND', message: 'No such workspace.' });
  if (BigInt(workspace.storage_quota_bytes) === BigInt(quotaBytes)) return;
  await operateQuota(tx, clock, workspace.slug, BigInt(quotaBytes));
  await recordServerAudit(tx, clock, {
    actorUserId: admin.userId,
    action: 'server.quota_changed',
    targetWorkspaceId: workspaceId,
  });
};

/**
 * The server administrator's grant of one module to one workspace, or its withdrawal (D-289), and the people to tell when it
 * changed something: nobody when it said what the table already said.
 */
export const changeWorkspaceModule = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  catalogue: EntitlementCatalogue,
  write: EntitlementWrite,
): Promise<readonly string[]> => {
  await lockServerAdministrator(tx, admin);
  const changes = await applyEntitlements(
    tx,
    clock,
    catalogue,
    { source: 'operator', userId: admin.userId },
    [write],
  );
  if (changes.length === 0) return [];
  const members = await tx
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', write.workspaceId)
    .execute();
  return members.map((member) => member.user_id);
};
