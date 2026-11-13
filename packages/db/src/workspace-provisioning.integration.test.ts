/** Reached source/group/grant constraints on the actual migrated SQL. */
import { afterAll, describe, expect, test } from 'bun:test';
import { sql, type RawBuilder, type Transaction } from 'kysely';
import type { DB } from './schema';
import { closeIntegrationDatabase, DROP_HOOK_MS, withRollback } from './testing';

const at = new Date('2026-11-12T18:00:00Z');
afterAll(closeIntegrationDatabase, DROP_HOOK_MS);

const fixture = async (
  db: Transaction<DB>,
): Promise<{
  workspace: string;
  foreignWorkspace: string;
  owner: string;
  person: string;
  manual: string;
  directory: string;
  directoryId: string;
  group: string;
  role: string;
}> => {
  const [owner, person] = [crypto.randomUUID(), crypto.randomUUID()];
  await db
    .insertInto('users')
    .values(
      [owner, person].map((id) => ({
        id,
        email: `${id}@test.invalid`,
        username: id,
        display_name: id,
      })),
    )
    .execute();
  const [workspace, foreignWorkspace] = [crypto.randomUUID(), crypto.randomUUID()];
  await db
    .insertInto('workspaces')
    .values([workspace, foreignWorkspace].map((id) => ({ id, name: id, slug: id })))
    .execute();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspace, user_id: owner, role: 'owner' },
      { workspace_id: workspace, user_id: person, role: 'member' },
    ])
    .execute();
  await db
    .insertInto('workspace_admission_controls')
    .values(
      [owner, person].map((userId) => ({
        workspace_id: workspace,
        user_id: userId,
        initialized_at: at,
        updated_at: at,
        last_builtin_role: userId === owner ? ('owner' as const) : ('member' as const),
        last_access_kind: 'member',
      })),
    )
    .execute();
  const [manual, directory, directoryId] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  await db
    .insertInto('workspace_access_sources')
    .values([
      {
        id: manual,
        workspace_id: workspace,
        user_id: owner,
        kind: 'manual',
        state: 'active',
        builtin_role: 'owner',
        access_kind: 'member',
        admitted_at: at,
        created_at: at,
        updated_at: at,
      },
      {
        id: directory,
        workspace_id: workspace,
        user_id: person,
        kind: 'directory',
        directory_id: directoryId,
        directory_link_reference: crypto.randomUUID(),
        state: 'active',
        builtin_role: 'member',
        access_kind: 'member',
        admitted_at: at,
        created_at: at,
        updated_at: at,
      },
    ])
    .execute();
  const [group, role] = [crypto.randomUUID(), crypto.randomUUID()];
  await db
    .insertInto('workspace_access_groups')
    .values({
      id: group,
      workspace_id: workspace,
      kind: 'manual',
      name: 'People',
      state: 'active',
      created_at: at,
      updated_at: at,
    })
    .execute();
  await db
    .insertInto('workspace_access_roles')
    .values({
      id: role,
      workspace_id: workspace,
      name: 'INVITE',
      capabilities: ['members.invite', 'channel.members.manage'],
      created_at: at,
      updated_at: at,
    })
    .execute();
  return {
    workspace,
    foreignWorkspace,
    owner,
    person,
    manual,
    directory,
    directoryId,
    group,
    role,
  };
};

const refused = async (
  db: Transaction<DB>,
  statement: RawBuilder<unknown>,
  code: string,
): Promise<void> => {
  await sql`savepoint invalid_workspace_access`.execute(db);
  let actual: string | undefined;
  try {
    await statement.execute(db);
  } catch (error) {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string')
      actual = error.code;
    else throw error;
  } finally {
    await sql`rollback to savepoint invalid_workspace_access`.execute(db);
    await sql`release savepoint invalid_workspace_access`.execute(db);
  }
  expect(actual).toBe(code);
};

// A selected integration suite must fail if its database is unavailable.
describe('integration: workspace source SQL', () => {
  test('source provenance, state revision and retirement are retained independently of native membership', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await refused(
        db,
        sql`update workspace_access_sources set user_id = ${f.owner} where id = ${f.directory}`,
        '23514',
      );
      await refused(
        db,
        sql`update workspace_access_sources set state = 'inactive', revision = gen_random_uuid() where id = ${f.directory}`,
        '23514',
      );
      await sql`update workspace_access_sources set state = 'inactive', revision = gen_random_uuid(), authorization_revision = gen_random_uuid() where id = ${f.directory}`.execute(
        db,
      );
      await sql`update workspace_access_sources set state = 'retired', retired_at = ${at}, revision = gen_random_uuid(), authorization_revision = gen_random_uuid() where id = ${f.directory}`.execute(
        db,
      );
      await refused(
        db,
        sql`update workspace_access_sources set state = 'active', retired_at = null, revision = gen_random_uuid(), authorization_revision = gen_random_uuid() where id = ${f.directory}`,
        '23514',
      );
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', f.workspace)
        .where('user_id', '=', f.person)
        .execute();
      expect(
        await db
          .selectFrom('workspace_admission_controls')
          .select('initialized_at')
          .where('workspace_id', '=', f.workspace)
          .where('user_id', '=', f.person)
          .executeTakeFirst(),
      ).toBeDefined();
      expect(
        (
          await db
            .selectFrom('workspace_access_sources')
            .select('state')
            .where('id', '=', f.directory)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('retired');
    });
  });

  test('directory sources cannot take a builtin privileged role, guest access or an unpaired identity', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      for (const mutation of [
        sql`builtin_role = 'owner'`,
        sql`builtin_role = 'admin'`,
        sql`access_kind = 'guest'`,
        sql`directory_link_reference = null`,
      ]) {
        await refused(
          db,
          sql`update workspace_access_sources set ${mutation}, revision = gen_random_uuid() where id = ${f.directory}`,
          '23514',
        );
      }
      await refused(
        db,
        sql`insert into workspace_access_sources(workspace_id,user_id,kind,directory_id,directory_link_reference,state,builtin_role,access_kind,admitted_at,created_at,updated_at) values (${f.workspace},${f.person},'directory',${f.directoryId},${crypto.randomUUID()},'active','member','member',${at},${at},${at})`,
        '23505',
      );
    });
  });

  test('group membership binds the exact native user and directory admission source', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await refused(
        db,
        sql`insert into workspace_access_group_members(workspace_id,group_id,user_id,source_id,created_at) values (${f.workspace},${f.group},${f.owner},${f.directory},${at})`,
        '23514',
      );
      const group = await db
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: f.workspace,
          kind: 'directory',
          directory_id: crypto.randomUUID(),
          directory_group_reference: crypto.randomUUID(),
          name: 'Other source',
          state: 'active',
          created_at: at,
          updated_at: at,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await refused(
        db,
        sql`insert into workspace_access_group_members(workspace_id,group_id,user_id,source_id,created_at) values (${f.workspace},${group.id},${f.person},${f.directory},${at})`,
        '23514',
      );
      await db
        .insertInto('workspace_access_group_members')
        .values({
          workspace_id: f.workspace,
          group_id: f.group,
          user_id: f.person,
          source_id: f.directory,
          created_at: at,
        })
        .execute();
      expect(
        await db
          .selectFrom('workspace_access_group_members')
          .select('id')
          .where('workspace_id', '=', f.workspace)
          .where('group_id', '=', f.group)
          .execute(),
      ).toHaveLength(1);
      await refused(
        db,
        sql`update workspace_access_groups set kind = 'directory', directory_id = ${f.directoryId}, directory_group_reference = ${crypto.randomUUID()}, revision = gen_random_uuid() where id = ${f.group}`,
        '23514',
      );
    });
  });

  test('roles refuse unknown, duplicate, null, empty and multidimensional capability arrays', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      for (const capabilities of [
        sql`array[]::text[]`,
        sql`array['owner']`,
        sql`array['members.invite','members.invite']`,
        sql`array['members.invite',null]`,
        sql`array[['members.invite'],['audit.read']]`,
      ]) {
        await refused(
          db,
          sql`update workspace_access_roles set capabilities = ${capabilities}, revision = gen_random_uuid() where id = ${f.role}`,
          '23514',
        );
      }
      await refused(
        db,
        sql`insert into workspace_access_roles(workspace_id,name,capabilities,created_at,updated_at) values (${f.workspace},'invite',array['audit.read'],${at},${at})`,
        '23505',
      );
      await sql`update workspace_access_roles set retired_at = ${at}, revision = gen_random_uuid() where id = ${f.role}`.execute(
        db,
      );
      await refused(
        db,
        sql`update workspace_access_roles set retired_at = null, revision = gen_random_uuid() where id = ${f.role}`,
        '23514',
      );
    });
  });

  test('grants require one existing same-workspace subject, and controls cannot be reset', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      await refused(
        db,
        sql`insert into workspace_access_role_grants(workspace_id,role_id,created_at) values (${f.workspace},${f.role},${at})`,
        '23514',
      );
      await refused(
        db,
        sql`insert into workspace_access_role_grants(workspace_id,role_id,source_id,group_id,created_at) values (${f.workspace},${f.role},${f.manual},${f.group},${at})`,
        '23514',
      );
      await refused(
        db,
        sql`insert into workspace_access_role_grants(workspace_id,role_id,source_id,created_at) values (${f.foreignWorkspace},${f.role},${f.manual},${at})`,
        '23503',
      );
      await db
        .insertInto('workspace_access_role_grants')
        .values({
          workspace_id: f.workspace,
          role_id: f.role,
          source_id: f.manual,
          created_at: at,
        })
        .execute();
      await refused(
        db,
        sql`update workspace_admission_controls set initialized_at = ${new Date(at.getTime() + 1)} where workspace_id = ${f.workspace} and user_id = ${f.person}`,
        '23514',
      );
      await refused(
        db,
        sql`update workspace_admission_controls set blocked_at = ${at} where workspace_id = ${f.workspace} and user_id = ${f.person}`,
        '23514',
      );
      await sql`update workspace_admission_controls set blocked_at = ${at}, revision = gen_random_uuid() where workspace_id = ${f.workspace} and user_id = ${f.person}`.execute(
        db,
      );
    });
  });
});
