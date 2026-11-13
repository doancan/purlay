/** Directory configuration and expiring bearers are controlled by the native builtin administrator. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import {
  DIRECTORY_CREDENTIALS_MAX,
  WORKSPACE_DIRECTORIES_MAX,
  type WorkspaceDirectory,
  type WorkspaceDirectoryPage,
  type CreateWorkspaceDirectoryRequest,
  type UpdateWorkspaceDirectoryRequest,
  type IssuedDirectoryCredential,
  type RotateDirectoryCredentialRequest,
  type RevokeDirectoryCredentialRequest,
} from '@purlay/types/workspace-directory';
import { AUTH_BASE_PATH, PAGE_LIMIT, type OlderPageQuery } from '@purlay/types';
import { atomicallyOn } from '../../../platform/transactions';
import { tokenDigest } from '../../../platform/tokens';
import { recordAudit } from '../../audit/audit';
import { lockWorkspaceProvisioningActor } from '../provisioning/authority';
import { noteWorkspaceAccessChange, noteCompanySessionsEnded } from '../provisioning/scope';
import { administerWorkspaceAccess } from '../provisioning/administration';
import { deactivateDirectorySources } from '../provisioning/directory-sources';
import {
  directoryMissing,
  directoryChanged,
  directoryInvalid,
  requireDirectoryReady,
  type WorkspaceDirectoryDependencies,
  type WorkspaceDirectoryActor,
} from './authority';
import { newDirectoryToken } from './credentials';

type DirectoryRow = Selectable<Database['workspace_directories']>;
const current = async (tx: Transaction, workspaceId: string, id: string): Promise<DirectoryRow> => {
  const row = await tx
    .selectFrom('workspace_directories')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw directoryMissing();
  return row;
};
type CredentialRow = Selectable<Database['workspace_directory_credentials']>;
const credentialMetadata = async (
  tx: Transaction,
  deps: WorkspaceDirectoryDependencies,
  workspaceId: string,
  ids: readonly string[],
): Promise<ReadonlyMap<string, readonly CredentialRow[]>> => {
  if (ids.length === 0) return new Map();
  const rows = await sql<CredentialRow>`select bounded.* from (
   select credential.*, row_number() over(partition by directory_id,
     (revoked_at is null and expires_at > ${deps.clock.now()}) order by created_at desc,id desc) as metadata_rank
   from workspace_directory_credentials as credential
   where workspace_id=${workspaceId} and directory_id=any(${ids}::uuid[])
 ) as bounded where metadata_rank<=5 order by created_at desc,id desc`.execute(tx);
  const byDirectory = new Map<string, CredentialRow[]>();
  for (const row of rows.rows) {
    const values = byDirectory.get(row.directory_id);
    if (values === undefined) byDirectory.set(row.directory_id, [row]);
    else values.push(row);
  }
  return byDirectory;
};
const publicDirectory = (
  deps: WorkspaceDirectoryDependencies,
  row: DirectoryRow,
  credentials: readonly CredentialRow[],
): WorkspaceDirectory => ({
  id: row.id,
  revision: row.revision,
  name: row.name,
  enabled: row.enabled,
  allowCreate: row.allow_create,
  connectionId: row.connection_id,
  claim: row.claim === 'sub' ? 'sub' : 'oid',
  scimUrl: new URL(`${AUTH_BASE_PATH}/scim/v2`, deps.baseUrl).toString(),
  createdAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
  credentials: credentials.map((c) => ({
    id: c.id,
    createdAt: new Date(c.created_at).toISOString(),
    expiresAt: new Date(c.expires_at).toISOString(),
    revokedAt: c.revoked_at === null ? null : new Date(c.revoked_at).toISOString(),
    lastUsedAt: c.last_used_at === null ? null : new Date(c.last_used_at).toISOString(),
  })),
});
const view = async (
  tx: Transaction,
  deps: WorkspaceDirectoryDependencies,
  row: DirectoryRow,
): Promise<WorkspaceDirectory> =>
  publicDirectory(
    deps,
    row,
    (await credentialMetadata(tx, deps, row.workspace_id, [row.id])).get(row.id) ?? [],
  );
const actorLock = async (
  tx: Transaction,
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
): Promise<void> => {
  await lockWorkspaceProvisioningActor(tx, deps, actor, 'administrator');
};
export const listWorkspaceDirectories = async (
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
  query: OlderPageQuery = {},
): Promise<WorkspaceDirectoryPage> =>
  await atomicallyOn(deps.database)(async (tx) => {
    await actorLock(tx, deps, actor);
    const limit = query.limit ?? PAGE_LIMIT.default;
    let statement = tx
      .selectFrom('workspace_directories')
      .selectAll()
      .where('workspace_id', '=', actor.context.workspaceId)
      .where('deleted_at', 'is', null)
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (query.before !== undefined) statement = statement.where('id', '<', query.before);
    const rows = await statement.execute();
    const page = rows.slice(0, limit);
    const metadata = await credentialMetadata(
      tx,
      deps,
      actor.context.workspaceId,
      page.map((row) => row.id),
    );
    const data = page.map((row) => publicDirectory(deps, row, metadata.get(row.id) ?? []));
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  });
export const createWorkspaceDirectory = async (
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
  input: CreateWorkspaceDirectoryRequest,
): Promise<WorkspaceDirectory> => {
  await requireDirectoryReady(deps.readersReady);
  return await administerWorkspaceAccess(deps, actor, 'revoke', async (tx, scope) => {
    const workspaceId = actor.context.workspaceId;
    if (input.name !== input.name.trim())
      throw directoryInvalid('name', 'Remove surrounding spaces.');
    const count = await tx
      .selectFrom('workspace_directories')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspace_id', '=', workspaceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirstOrThrow();
    if (Number(count.count) >= WORKSPACE_DIRECTORIES_MAX)
      throw directoryInvalid('name', 'This workspace already has eight directories.');
    const connection = await tx
      .selectFrom('workspace_identity_connections')
      .select(['id', 'directory_id'])
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', input.connectionId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (connection === undefined) throw directoryMissing();
    if (connection.directory_id !== null) throw directoryChanged();
    const duplicate = await tx
      .selectFrom('workspace_directories')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('name', '=', input.name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (duplicate !== undefined)
      throw directoryInvalid('name', 'This directory name is already used.');
    const now = deps.clock.now();
    const row = await tx
      .insertInto('workspace_directories')
      .values({
        workspace_id: workspaceId,
        connection_id: input.connectionId,
        claim: input.claim,
        name: input.name,
        allow_create: input.allowCreate,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await tx
      .updateTable('workspace_identity_connections')
      .set({
        directory_id: row.id,
        directory_claim: row.claim,
        revision: crypto.randomUUID(),
        updated_at: now,
      })
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', connection.id)
      .execute();
    noteWorkspaceAccessChange(tx, scope);
    await recordAudit(tx, deps.clock, {
      workspaceId,
      actorUserId: actor.context.userId,
      action: 'directory.created',
      targetType: 'integration',
      targetId: row.id,
    });
    return await view(tx, deps, row);
  });
};
export const updateWorkspaceDirectory = async (
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
  id: string,
  input: UpdateWorkspaceDirectoryRequest,
): Promise<WorkspaceDirectory> => {
  await requireDirectoryReady(deps.readersReady);
  return await administerWorkspaceAccess(deps, actor, 'revoke', async (tx, scope) => {
    const old = await current(tx, actor.context.workspaceId, id);
    if (old.revision !== input.revision) throw directoryChanged();
    if (input.name !== undefined && input.name !== input.name.trim())
      throw directoryInvalid('name', 'Remove surrounding spaces.');
    if (input.name !== undefined && input.name !== old.name) {
      const duplicate = await tx
        .selectFrom('workspace_directories')
        .select('id')
        .where('workspace_id', '=', old.workspace_id)
        .where('name', '=', input.name)
        .where('deleted_at', 'is', null)
        .where('id', '!=', id)
        .executeTakeFirst();
      if (duplicate !== undefined)
        throw directoryInvalid('name', 'This directory name is already used.');
    }
    const row = await tx
      .updateTable('workspace_directories')
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.allowCreate === undefined ? {} : { allow_create: input.allowCreate }),
        revision: crypto.randomUUID(),
        updated_at: deps.clock.now(),
      })
      .where('id', '=', id)
      .where('workspace_id', '=', old.workspace_id)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (old.enabled && !row.enabled) {
      await deactivateDirectorySources(tx, deps, scope, id);
      const ended = (
        await tx
          .selectFrom('workspace_identity_sessions')
          .select('session_id')
          .where('workspace_id', '=', old.workspace_id)
          .where('directory_id', '=', id)
          .execute()
      ).map((r) => r.session_id);
      noteCompanySessionsEnded(tx, scope, ended);
    }
    noteWorkspaceAccessChange(tx, scope);
    await recordAudit(tx, deps.clock, {
      workspaceId: old.workspace_id,
      actorUserId: actor.context.userId,
      ...(old.enabled && !row.enabled
        ? { action: 'directory.disabled' as const }
        : { action: 'directory.updated' as const }),
      targetType: 'integration',
      targetId: id,
    });
    return await view(tx, deps, row);
  });
};
export const deleteWorkspaceDirectory = async (
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
  id: string,
  revision: string,
): Promise<void> => {
  await requireDirectoryReady(deps.readersReady);
  await administerWorkspaceAccess(deps, actor, 'revoke', async (tx, scope) => {
    const old = await current(tx, actor.context.workspaceId, id);
    if (old.revision !== revision) throw directoryChanged();
    const now = deps.clock.now();
    await tx
      .updateTable('workspace_directories')
      .set({ enabled: false, deleted_at: now, revision: crypto.randomUUID(), updated_at: now })
      .where('workspace_id', '=', old.workspace_id)
      .where('id', '=', id)
      .execute();
    await tx
      .updateTable('workspace_directory_credentials')
      .set({ revoked_at: now })
      .where('workspace_id', '=', old.workspace_id)
      .where('directory_id', '=', id)
      .where('revoked_at', 'is', null)
      .execute();
    await deactivateDirectorySources(tx, deps, scope, id);
    noteWorkspaceAccessChange(tx, scope);
    await recordAudit(tx, deps.clock, {
      workspaceId: old.workspace_id,
      actorUserId: actor.context.userId,
      action: 'directory.deleted',
      targetType: 'integration',
      targetId: id,
    });
    const ended = (
      await tx
        .selectFrom('workspace_identity_sessions')
        .select('session_id')
        .where('workspace_id', '=', old.workspace_id)
        .where('directory_id', '=', id)
        .execute()
    ).map((r) => r.session_id);
    noteCompanySessionsEnded(tx, scope, ended);
  });
};
export const rotateDirectoryCredential = async (
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
  id: string,
  input: RotateDirectoryCredentialRequest,
): Promise<IssuedDirectoryCredential> => {
  await requireDirectoryReady(deps.readersReady);
  return await administerWorkspaceAccess(deps, actor, 'revoke', async (tx, scope) => {
    const old = await current(tx, actor.context.workspaceId, id);
    if (old.revision !== input.revision) throw directoryChanged();
    const now = deps.clock.now();
    const live = await tx
      .selectFrom('workspace_directory_credentials')
      .select(['id', 'expires_at'])
      .where('workspace_id', '=', old.workspace_id)
      .where('directory_id', '=', id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .execute();
    if (input.overlapMinutes > 0 && live.length >= DIRECTORY_CREDENTIALS_MAX)
      throw directoryInvalid(
        'overlapMinutes',
        'Revoke an existing credential before issuing another overlapping token.',
      );
    if (input.overlapMinutes === 0)
      await tx
        .updateTable('workspace_directory_credentials')
        .set({ revoked_at: now })
        .where('workspace_id', '=', old.workspace_id)
        .where('directory_id', '=', id)
        .where('revoked_at', 'is', null)
        .execute();
    else
      for (const prior of live)
        await tx
          .updateTable('workspace_directory_credentials')
          .set({
            expires_at: new Date(
              Math.min(
                new Date(prior.expires_at).getTime(),
                now.getTime() + input.overlapMinutes * 60_000,
              ),
            ),
          })
          .where('id', '=', prior.id)
          .where('workspace_id', '=', old.workspace_id)
          .execute();
    const credentialId = crypto.randomUUID();
    const token = newDirectoryToken(credentialId);
    const credential = await tx
      .insertInto('workspace_directory_credentials')
      .values({
        id: credentialId,
        workspace_id: old.workspace_id,
        directory_id: id,
        token_hash: await tokenDigest(token),
        created_at: now,
        expires_at: new Date(now.getTime() + input.expiresInDays * 86_400_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const row = await tx
      .updateTable('workspace_directories')
      .set({ revision: crypto.randomUUID(), updated_at: now })
      .where('workspace_id', '=', old.workspace_id)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    noteWorkspaceAccessChange(tx, scope);
    await recordAudit(tx, deps.clock, {
      workspaceId: old.workspace_id,
      actorUserId: actor.context.userId,
      action: 'directory.credential_rotated',
      targetType: 'integration',
      targetId: id,
    });
    return {
      directory: await view(tx, deps, row),
      credential: {
        id: credential.id,
        createdAt: now.toISOString(),
        expiresAt: new Date(credential.expires_at).toISOString(),
        revokedAt: null,
        lastUsedAt: null,
      },
      token,
    };
  });
};
export const revokeDirectoryCredential = async (
  deps: WorkspaceDirectoryDependencies,
  actor: WorkspaceDirectoryActor,
  id: string,
  input: RevokeDirectoryCredentialRequest,
): Promise<WorkspaceDirectory> => {
  await requireDirectoryReady(deps.readersReady);
  return await administerWorkspaceAccess(deps, actor, 'revoke', async (tx, scope) => {
    const old = await current(tx, actor.context.workspaceId, id);
    if (old.revision !== input.revision) throw directoryChanged();
    const now = deps.clock.now();
    const credential = await tx
      .selectFrom('workspace_directory_credentials')
      .select('id')
      .where('workspace_id', '=', old.workspace_id)
      .where('directory_id', '=', id)
      .where('id', '=', input.credentialId)
      .executeTakeFirst();
    if (credential === undefined) throw directoryMissing();
    await tx
      .updateTable('workspace_directory_credentials')
      .set({ revoked_at: now })
      .where('workspace_id', '=', old.workspace_id)
      .where('id', '=', credential.id)
      .where('revoked_at', 'is', null)
      .execute();
    const row = await tx
      .updateTable('workspace_directories')
      .set({ revision: crypto.randomUUID(), updated_at: now })
      .where('workspace_id', '=', old.workspace_id)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
    noteWorkspaceAccessChange(tx, scope);
    await recordAudit(tx, deps.clock, {
      workspaceId: old.workspace_id,
      actorUserId: actor.context.userId,
      action: 'directory.credential_revoked',
      targetType: 'integration',
      targetId: id,
    });
    return await view(tx, deps, row);
  });
};
