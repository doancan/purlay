/** Server-wide metadata, guarded independently of workspace membership. Never reads content tables. */
import { sql, type Executor } from '@purlay/db';
import type {
  ServerAuditPage,
  ServerAuditQuery,
  ServerUser,
  ServerUserPage,
  ServerUsersQuery,
  ServerUserDetail,
  ServerWorkspacePage,
  ServerWorkspacesQuery,
} from '@purlay/types';
import type { ServerAdminSession } from '../setup/setup';
import { literalPattern } from '../../platform/like-pattern';
import { AppError } from '../../platform/errors';
import { serverRetention } from '../workspaces/retention';
import { lapseCutoffs, type SessionLifetime } from '../auth/session-lifetime';
import { snapshotOn } from '../../platform/transactions';

const userColumns = [
  'id',
  'username',
  'display_name',
  'email',
  'email_verified',
  'admission_state',
  'is_server_admin',
  'suspended_at',
  'created_at',
  'last_seen_at',
] as const;
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());
const userView = (row: {
  id: string;
  username: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  admission_state: string;
  is_server_admin: boolean;
  suspended_at: Date | null;
  created_at: Date;
  last_seen_at: Date | null;
}): ServerUser => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  email: row.email,
  emailVerified: row.email_verified,
  admissionState:
    row.admission_state === 'pending' || row.admission_state === 'denied'
      ? row.admission_state
      : 'approved',
  isServerAdmin: row.is_server_admin,
  suspendedAt: iso(row.suspended_at),
  createdAt: row.created_at.toISOString(),
  lastSeenAt: iso(row.last_seen_at),
});

export const listServerUsers = async (
  db: Executor,
  _admin: ServerAdminSession,
  query: ServerUsersQuery,
): Promise<ServerUserPage> => {
  const limit = query.limit ?? 50;
  let statement = db
    .selectFrom('users')
    .select(userColumns)
    .where('deleted_at', 'is', null)
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.after !== undefined) statement = statement.where('id', '<', query.after);
  if (query.status === 'active')
    statement = statement
      .where('suspended_at', 'is', null)
      .where('admission_state', '=', 'approved')
      .where((eb) =>
        eb.or([
          eb('admission_requires_verified_email', '=', false),
          eb('email_verified', '=', true),
        ]),
      );
  if (query.status === 'pending' || query.status === 'denied')
    statement = statement.where('admission_state', '=', query.status);
  if (query.status === 'suspended') statement = statement.where('suspended_at', 'is not', null);
  if (query.status === 'admins') statement = statement.where('is_server_admin', '=', true);
  const words = query.q?.trim();
  if (words) {
    const pattern = literalPattern(words);
    statement = statement.where((eb) =>
      eb.or([
        eb('display_name', 'ilike', pattern),
        eb('username', 'ilike', pattern),
        eb('email', 'ilike', pattern),
      ]),
    );
  }
  const rows = await statement.execute();
  const data = rows.slice(0, limit).map(userView);
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
};

export const serverUserDetail = async (
  db: Executor,
  _admin: ServerAdminSession,
  userId: string,
  after: string | undefined,
  now: Date,
  lifetime: SessionLifetime,
): Promise<ServerUserDetail> => {
  const user = await db
    .selectFrom('users')
    .select(userColumns)
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (user === undefined)
    throw new AppError({ code: 'USER_NOT_FOUND', message: 'No such account.' });
  let memberships = db
    .selectFrom('workspace_members as m')
    .innerJoin('workspaces as w', 'w.id', 'm.workspace_id')
    .select(['w.id', 'w.name', 'w.slug', 'm.role'])
    .where('m.user_id', '=', userId)
    .where('w.deleted_at', 'is', null)
    .orderBy('w.id', 'desc')
    .limit(51);
  if (after !== undefined) memberships = memberships.where('w.id', '<', after);
  const rows = await memberships.execute();
  const { usedBy, createdBy } = lapseCutoffs(lifetime, now);
  let live = db
    .selectFrom('sessions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', now);
  if (usedBy !== undefined) live = live.where('last_used_at', '>', usedBy);
  if (createdBy !== undefined) live = live.where('created_at', '>', createdBy);
  const sessions = await live.executeTakeFirstOrThrow();
  return {
    user: userView(user),
    memberships: rows.slice(0, 50).map((row) => ({
      workspaceId: row.id,
      workspaceName: row.name,
      workspaceSlug: row.slug,
      role: row.role,
    })),
    nextCursor: rows.length > 50 ? (rows[49]?.id ?? null) : null,
    activeSessions: Number(sessions.count),
  };
};

export const listServerWorkspaces = async (
  db: Executor,
  admin: ServerAdminSession,
  query: ServerWorkspacesQuery,
): Promise<ServerWorkspacePage> =>
  await snapshotOn(db)(async (tx) => {
    const limit = query.limit ?? 50;
    // Pending uploads already consume space in the store, just as storageOf counts them for an upload.
    const used = sql<string>`(w.storage_used_bytes + coalesce((select sum(a.size_bytes) from attachments a where a.workspace_id = w.id and a.claimed_at is null), 0))`;
    let statement = tx
      .selectFrom('workspaces as w')
      .select([
        'w.id',
        'w.name',
        'w.slug',
        'w.created_at',
        'w.deleted_at',
        'w.purged_at',
        'w.storage_quota_bytes',
      ])
      .select([
        used.as('used'),
        sql<string>`(select count(*) from workspace_members m where m.workspace_id = w.id)`.as(
          'members',
        ),
        sql<string>`(select count(*) from workspace_members m where m.workspace_id = w.id and m.role = 'owner')`.as(
          'owners_count',
        ),
        sql<
          { id: string; displayName: string }[]
        >`(select coalesce(json_agg(o), '[]'::json) from (select u.id, u.display_name as "displayName" from workspace_members m join users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by u.id limit 3) o)`.as(
          'owners',
        ),
      ])
      .orderBy('w.id', 'desc')
      .limit(limit + 1);
    if (query.after !== undefined) statement = statement.where('w.id', '<', query.after);
    if (query.status === 'deleted') statement = statement.where('w.deleted_at', 'is not', null);
    else if (query.status === 'active' || query.status === 'full')
      statement = statement.where('w.deleted_at', 'is', null);
    if (query.status === 'full')
      statement = statement.where(used, '>=', sql<string>`w.storage_quota_bytes`);
    const words = query.q?.trim();
    if (words) {
      const pattern = literalPattern(words);
      statement = statement.where((eb) =>
        eb.or([eb('w.name', 'ilike', pattern), eb('w.slug', 'ilike', pattern)]),
      );
    }
    const rows = await statement.execute();
    const visible = rows.slice(0, limit);
    const retention = await serverRetention(
      tx,
      admin,
      visible.map((row) => row.id),
    );
    const data = visible.map((row) => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.created_at.toISOString(),
      deletedAt: iso(row.deleted_at),
      purgedAt: iso(row.purged_at),
      memberCount: Number(row.members),
      ownerCount: Number(row.owners_count),
      owners: row.owners,
      usedBytes: row.used,
      quotaBytes: row.storage_quota_bytes,
      retentionDays: retention.get(row.id) ?? null,
    }));
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  });

export const listServerAudit = async (
  db: Executor,
  _admin: ServerAdminSession,
  query: ServerAuditQuery,
): Promise<ServerAuditPage> => {
  if (
    query.from !== undefined &&
    query.to !== undefined &&
    Date.parse(query.from) > Date.parse(query.to)
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The start must not follow the end.',
      details: { fields: { from: 'Must not follow the end.' } },
    });
  }
  const limit = query.limit ?? 50;
  let statement = db
    .selectFrom('server_audit_log as a')
    .leftJoin('users as u', 'u.id', 'a.actor_user_id')
    .select([
      'a.id',
      'a.action',
      'a.actor_user_id',
      'a.target_user_id',
      'a.target_workspace_id',
      'a.target_module',
      'a.created_at',
      'u.display_name',
    ])
    .orderBy('a.id', 'desc')
    .limit(limit + 1);
  if (query.after !== undefined) statement = statement.where('a.id', '<', query.after);
  if (query.action !== undefined) statement = statement.where('a.action', '=', query.action);
  if (query.actorUserId !== undefined)
    statement = statement.where('a.actor_user_id', '=', query.actorUserId);
  if (query.targetUserId !== undefined)
    statement = statement.where('a.target_user_id', '=', query.targetUserId);
  if (query.targetWorkspaceId !== undefined)
    statement = statement.where('a.target_workspace_id', '=', query.targetWorkspaceId);
  if (query.from !== undefined)
    statement = statement.where('a.created_at', '>=', new Date(query.from));
  if (query.to !== undefined) statement = statement.where('a.created_at', '<=', new Date(query.to));
  const rows = await statement.execute();
  const data = rows.slice(0, limit).map((row) => ({
    id: row.id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actorName: row.display_name,
    targetUserId: row.target_user_id,
    targetWorkspaceId: row.target_workspace_id,
    targetModule: row.target_module,
    createdAt: row.created_at.toISOString(),
  }));
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
};
