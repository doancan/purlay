/**
 * What a database that last ran an earlier release becomes when it starts the next (D-250, D-86).
 *
 * The sets of the modules are applied after the core's, and a module's table is made from the core's: so the
 * state that matters is not an empty database but one with rows in it. This builds an earlier release's schema
 * from its migration files, puts attachments in it as that release wrote them — some sent with a message, one
 * whose message was deleted, some not sent — and migrates to head the way a process does, with the core's
 * directory and every module's set. What was linked is linked, what was not is not, the keys keep what they kept,
 * and the columns of `attachments` that named a message are gone only where chat's link table carries every one
 * (`chat/0005`): from the previous release in one run, from the release that expanded in a run of its own, and
 * refused, with nothing changed, where a link is missing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  MIGRATIONS_DIRECTORY,
  migrateToLatest,
  PRODUCT_MIGRATION_SETS,
  setsNamedBy,
  type MigrationSet,
} from './migrator';
import { splitStatements } from './statements';
import {
  backendsGone,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  dropDatabases,
  DROP_HOOK_MS,
} from './testing';

/** The first migration of the release that expanded: everything before it is the previous release's schema. */
const EXPAND_RELEASE_STARTS_AT = '0079_attachment_claims.sql';

/** The first migration of the release that contracts, in chat's set: the expand release has everything before it. */
const CONTRACT_STARTS_AT = '0005_message_attachments_contract.sql';
const CONTRACT_MIGRATION = 'chat/0005_message_attachments_contract';

const directories: string[] = [];
const databases: string[] = [];

/** A connection to the server's database of this name. */
const open = (name: string): Kysely<unknown> => {
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${name}`;
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 1 }),
    }),
  });
};

// Dropped together: each drop makes the server checkpoint, and nine of them one after another outlived the five
// seconds a hook is given on a loaded runner (`dropDatabases`, #797).
afterAll(async () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  await dropDatabases(databases);
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** The `.sql` files of a directory that are below `end` (or all of them), copied where they can be applied alone. */
const copiedBelow = (from: string, end: string | undefined): string => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-release-'));
  directories.push(directory);
  for (const file of readdirSync(from)) {
    if (file.endsWith('.sql') && (end === undefined || file < end)) {
      copyFileSync(join(from, file), join(directory, file));
    }
  }
  return directory;
};

/** The previous release's migrations: the core's files below the first of the expand release, and no module's. */
const previousRelease = (): string => copiedBelow(MIGRATIONS_DIRECTORY, EXPAND_RELEASE_STARTS_AT);

/**
 * The expand release's migrations (v0.3.0): all the core's, chat's set up to the contract, and the issues set. What
 * a production database is at when the contract release starts.
 */
const expandRelease = (): { core: string; sets: MigrationSet[] } => ({
  core: copiedBelow(MIGRATIONS_DIRECTORY, undefined),
  sets: PRODUCT_MIGRATION_SETS.map((set) => ({
    id: set.id,
    directory: copiedBelow(set.directory, set.id === 'chat' ? CONTRACT_STARTS_AT : undefined),
  })),
});

/**
 * An empty database of its own. Not a schema in the shared one: the migrations name the extensions they use
 * (trigram, GIN) and drop and make tables by bare name, so a search path that reached the shared schema would reach its
 * tables too.
 */
const emptyDatabase = async (template?: string): Promise<string> => {
  const name = `upgrade_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = open('postgres');
  try {
    if (template === undefined) await sql`create database ${sql.id(name)}`.execute(admin);
    else await sql`create database ${sql.id(name)} template ${sql.id(template)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  databases.push(name);
  return name;
};

/** The columns `attachments` has, in the schema the connection sees. */
const columnsOfAttachments = async (db: Kysely<unknown>): Promise<string[]> =>
  (
    await sql<{ name: string }>`
      select column_name as name from information_schema.columns
      where table_schema = current_schema() and table_name = 'attachments' order by 1`.execute(db)
  ).rows.map((row) => row.name);

/**
 * What the table has that names a message or a channel: a foreign key to either, the check that tied the two
 * columns, and the indexes over them. Empty once the columns are gone.
 */
const namesOfAttachmentsKeys = async (db: Kysely<unknown>): Promise<string[]> => {
  const constraints = await sql<{ name: string }>`
    select conname as name from pg_constraint
    where conrelid = 'attachments'::regclass
      and (confrelid in ('messages'::regclass, 'channels'::regclass)
           or conname = 'attachments_channel_iff_message')`.execute(db);
  const indexes = await sql<{ name: string }>`
    select indexname as name from pg_indexes
    where schemaname = current_schema() and tablename = 'attachments'
      and indexname in ('idx_attachments_message', 'idx_attachments_channel', 'idx_attachments_unattached')`.execute(
    db,
  );
  return [...constraints.rows, ...indexes.rows].map((row) => row.name).sort();
};

interface ExpandedWorld {
  readonly workspace: string;
  readonly channel: string;
  readonly liveMessage: string;
  readonly deletedMessage: string;
  /** Sent with the live message, and with the deleted one (a tombstone keeps its file), and never sent. */
  readonly sent: string;
  readonly keptByTombstone: string;
  readonly unsent: string;
}

/**
 * Rows as the release that expanded wrote them: a send sets the columns and the claim and writes the link, a
 * deleted message keeps its file and its link, an upload nobody sent has none of the three.
 */
const writeLikeTheExpandRelease = async (db: Kysely<unknown>): Promise<ExpandedWorld> => {
  const at = new Date('2026-10-02T12:00:00.000Z');
  const uuid = (offset: number): string => Bun.randomUUIDv7('hex', new Date(at.getTime() + offset));
  const { rows: people } = await sql<{ id: string }>`
    insert into users (email, username, display_name) values ('b@example.test', 'b', 'B') returning id`.execute(
    db,
  );
  const user = people[0]?.id ?? '';
  const { rows: spaces } = await sql<{ id: string }>`
    insert into workspaces (name, slug, created_by) values ('W', 'w2', ${user}) returning id`.execute(
    db,
  );
  const workspace = spaces[0]?.id ?? '';
  const { rows: rooms } = await sql<{ id: string }>`
    insert into channels (workspace_id, name, created_by) values (${workspace}, 'general', ${user}) returning id`.execute(
    db,
  );
  const channel = rooms[0]?.id ?? '';
  const world: ExpandedWorld = {
    workspace,
    channel,
    liveMessage: uuid(1),
    deletedMessage: uuid(2),
    sent: uuid(3),
    keptByTombstone: uuid(4),
    unsent: uuid(5),
  };
  for (const [id, deletedAt] of [
    [world.liveMessage, null],
    [world.deletedMessage, at],
  ] as const) {
    await sql`
      insert into messages (id, workspace_id, channel_id, sender_id, content, created_at, deleted_at)
      values (${id}, ${workspace}, ${channel}, ${user}, 'with a file', ${at}, ${deletedAt})`.execute(
      db,
    );
  }
  for (const [id, message] of [
    [world.sent, world.liveMessage],
    [world.keptByTombstone, world.deletedMessage],
    [world.unsent, null],
  ] as const) {
    await sql`
      insert into attachments (id, workspace_id, uploader_id, storage_key, file_name, mime_type, size_bytes,
                               message_id, channel_id, claimed_at)
      values (${id}, ${workspace}, ${user}, ${`k/${id}`}, 'f.txt', 'text/plain', 10, ${message},
              ${message === null ? null : channel}, ${message === null ? null : at})`.execute(db);
    if (message !== null) {
      await sql`
        insert into message_attachments (attachment_id, workspace_id, message_id, channel_id)
        values (${id}, ${workspace}, ${message}, ${channel})`.execute(db);
    }
  }
  return world;
};

const linksOf = async (db: Kysely<unknown>): Promise<string[]> =>
  (
    await sql<{ attachment_id: string }>`
      select attachment_id from message_attachments order by attachment_id`.execute(db)
  ).rows.map((row) => row.attachment_id);

interface ExpandedTemplate {
  readonly name: string;
  readonly world: ExpandedWorld;
  readonly sets: MigrationSet[];
}

let expandedTemplate: ExpandedTemplate | undefined;

/**
 * The database that has run the release that expanded, with rows as that release wrote them, made once for the
 * file: six tests start from it, and replaying every migration for each cost a second apiece, on a runner that
 * was already late. Nothing is connected to it when it is cloned.
 */
beforeAll(async () => {
  const name = await emptyDatabase();
  const db = open(name);
  try {
    const { core, sets } = expandRelease();
    const expanded = await migrateToLatest(db, core, { modules: sets });
    expect(expanded.error).toBeUndefined();
    expect(expanded.results?.at(-1)?.migrationName).toBe('issues/0002_issues_search');
    expandedTemplate = { name, world: await writeLikeTheExpandRelease(db), sets };
  } finally {
    await db.destroy();
  }
  // A pool that has ended is not yet a connection that has closed, and a clone refuses a source in use.
  expect(await backendsGone(name, 5_000)).toBe(true);
}, CLONE_HOOK_MS);

/** A database of its own, copied from the one that has run the release that expanded. */
const expandedDatabase = async (): Promise<{
  db: Kysely<unknown>;
  world: ExpandedWorld;
  sets: MigrationSet[];
}> => {
  if (expandedTemplate === undefined) throw new Error('the expand release was not built');
  const { name, world, sets } = expandedTemplate;
  return { db: open(await emptyDatabase(name)), world, sets };
};

describe('integration: upgrading from the previous release', () => {
  test('from the previous release in one run: claims what was sent, links it in chat’s own table, and drops the columns', async () => {
    const db = open(await emptyDatabase());
    try {
      const before = await migrateToLatest(db, previousRelease());
      expect(before.error).toBeUndefined();
      expect(before.results?.at(-1)?.migrationName).toBe('0078_google_sign_in');

      // The previous release's data: a workspace, a channel, a message, and three uploads — one sent with the
      // message, one sent with a second, one not sent at all.
      const at = new Date('2026-10-01T12:00:00.000Z');
      const messageId = (when: Date): string => Bun.randomUUIDv7('hex', when);
      const sent = messageId(new Date(at.getTime() + 1));
      const sentTwice = messageId(new Date(at.getTime() + 2));
      const unsent = messageId(new Date(at.getTime() + 3));
      const first = messageId(new Date(at.getTime() + 4));
      const second = messageId(new Date(at.getTime() + 5));
      const { rows: people } = await sql<{ id: string }>`
        insert into users (email, username, display_name)
        values ('a@example.test', 'a', 'A') returning id`.execute(db);
      const user = people[0]?.id ?? '';
      const { rows: spaces } = await sql<{ id: string }>`
        insert into workspaces (name, slug, created_by) values ('W', 'w', ${user}) returning id`.execute(
        db,
      );
      const workspace = spaces[0]?.id ?? '';
      const { rows: rooms } = await sql<{ id: string }>`
        insert into channels (workspace_id, name, created_by) values (${workspace}, 'general', ${user})
        returning id`.execute(db);
      const channel = rooms[0]?.id ?? '';
      for (const id of [first, second]) {
        await sql`
          insert into messages (id, workspace_id, channel_id, sender_id, content, created_at)
          values (${id}, ${workspace}, ${channel}, ${user}, 'with a file', ${at})`.execute(db);
      }
      for (const [id, message] of [
        [sent, first],
        [sentTwice, second],
        [unsent, null],
      ] as const) {
        await sql`
          insert into attachments (id, workspace_id, uploader_id, storage_key, file_name, mime_type, size_bytes,
                                   message_id, channel_id)
          values (${id}, ${workspace}, ${user}, ${`k/${id}`}, 'f.txt', 'text/plain', 10, ${message},
                  ${message === null ? null : channel})`.execute(db);
      }

      // The second message was deleted before the upgrade: a tombstone keeps its file, and so its link.
      await sql`update messages set deleted_at = ${at} where id = ${second}`.execute(db);

      // Migrated the way a process migrates: the core's files, then each module's set.
      const after = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(after.error).toBeUndefined();
      expect(after.results?.map((result) => result.migrationName)).toEqual([
        '0079_attachment_claims',
        '0080_away_chosen',
        '0081_message_search_branches',
        '0082_server_operations',
        '0083_server_audit_filters',
        '0084_server_admission_identity',
        '0085_administration_counts',
        '0086_invitation_recipients',
        '0087_invitation_recipient_foreign_keys',
        '0088_inbox_entries',
        '0089_outbox',
        '0090_workspace_modules',
        '0091_outbox_pending_by_workspace',
        '0092_suspended_modules',
        '0093_outbox_fair_claim',
        '0094_audit_target_fact',
        '0095_outbox_discarded',
        '0096_server_audit_grant_detail',
        '0097_server_push_settings',
        '0098_push_subscription_sound',
        '0099_workspace_guest_access',
        '0100_guest_invitation_token_encoding',
        '0101_workspace_guest_directory',
        '0102_push_delivery',
        '0103_push_capture_order',
        '0104_push_state_index',
        '0105_workspace_identity',
        '0106_company_session_origin',
        '0107_company_native_origin',
        '0108_session_authentication_evidence',
        '0109_workspace_access_policy',
        '0110_workspace_mfa',
        '0111_authentication_company_tuple',
        '0112_workspace_mfa_deadline',
        '0113_deferred_author_session',
        '0114_personal_archive_workspaces',
        '0115_workspace_policy_lookup',
        '0116_workspace_provisioning',
        '0117_workspace_directory',
        '0118_directory_source_lookup',
        '0119_directory_native_initialization',
        '0120_workspace_directory_validate',
        'chat/0001_message_attachments',
        'chat/0002_scheduled_messages',
        'chat/0003_message_reminders',
        'chat/0004_hidden_messages',
        CONTRACT_MIGRATION,
        'chat/0006_channel_departures',
        'chat/0007_read_scopes',
        'chat/0008_unread_history_range',
        'chat/0009_thread_read_baseline',
        'chat/0010_membership_read_scopes',
        'chat/0011_personal_channel_groups',
        'chat/0012_removed_membership_scope',
        'chat/0013_missed_mail_claims',
        'chat/0014_shared_catalogue',
        'chat/0015_shared_source_changes',
        'chat/0016_shared_source_indexes',
        'chat/0017_deferred_author_session',
        'chat/0018_channel_access_sources',
        'issues/0001_issues',
        'issues/0002_issues_search',
      ]);
      expect(await columnsOfAttachments(db)).not.toContain('message_id');
      expect(await columnsOfAttachments(db)).not.toContain('channel_id');
      expect(await namesOfAttachmentsKeys(db)).toEqual([]);

      const links = await sql<{ attachment_id: string; message_id: string; channel_id: string }>`
        select attachment_id, message_id, channel_id from message_attachments order by attachment_id`.execute(
        db,
      );
      expect(links.rows).toEqual(
        [
          { attachment_id: sent, message_id: first, channel_id: channel },
          { attachment_id: sentTwice, message_id: second, channel_id: channel },
        ].sort((a, b) => (a.attachment_id < b.attachment_id ? -1 : 1)),
      );
      const claimed = await sql<{ id: string; claimed: boolean }>`
        select id, claimed_at is not null as claimed from attachments order by id`.execute(db);
      expect(claimed.rows).toEqual(
        [
          { id: sent, claimed: true },
          { id: sentTwice, claimed: true },
          { id: unsent, claimed: false },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      );

      // Starting again changes nothing.
      const again = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(again.error).toBeUndefined();
      expect(again.results).toEqual([]);
      const count = await sql<{ n: string }>`select count(*) as n from message_attachments`.execute(
        db,
      );
      expect(count.rows[0]?.n).toBe('2');

      // The keys keep what they kept, each on its own. A second workspace with a channel and a message of its own:
      const { rows: others } = await sql<{ id: string }>`
        insert into workspaces (name, slug, created_by) values ('X', 'x', ${user}) returning id`.execute(
        db,
      );
      const other = others[0]?.id ?? '';
      const { rows: otherRooms } = await sql<{ id: string }>`
        insert into channels (workspace_id, name, created_by) values (${other}, 'general', ${user})
        returning id`.execute(db);
      const otherChannel = otherRooms[0]?.id ?? '';
      const foreign = messageId(new Date(at.getTime() + 6));
      await sql`
        insert into messages (id, workspace_id, channel_id, sender_id, content, created_at)
        values (${foreign}, ${other}, ${otherChannel}, ${user}, 'elsewhere', ${at})`.execute(db);
      const refused = async (
        workspaceId: string,
        message: string,
        channelId: string,
      ): Promise<string> => {
        try {
          await sql`insert into message_attachments (attachment_id, workspace_id, message_id, channel_id)
            values (${unsent}, ${workspaceId}, ${message}, ${channelId})`.execute(db);
        } catch (error) {
          return String((error as { constraint?: string }).constraint ?? error);
        }
        return 'accepted';
      };
      // An attachment of this workspace in another's message and workspace: only the key to the attachment refuses.
      expect(await refused(other, foreign, otherChannel)).toBe(
        'message_attachments_attachment_fkey',
      );
      // …in this workspace's name, with another's message: only the message's workspace refuses.
      expect(await refused(workspace, foreign, otherChannel)).toBe(
        'message_attachments_message_workspace_fkey',
      );
      // …with this workspace's message and another's channel: only the message's channel refuses.
      expect(await refused(workspace, first, otherChannel)).toBe(
        'message_attachments_message_channel_fkey',
      );

      // And deleting the message takes its link with it.
      await sql`delete from messages where id = ${first}`.execute(db);
      const left = await sql<{ n: string }>`select count(*) as n from message_attachments`.execute(
        db,
      );
      expect(left.rows[0]?.n).toBe('1');
    } finally {
      await db.destroy();
    }
  });
});

describe('integration: the contract release on a database that has run the expand release', () => {
  test('drops the columns, their keys and indexes, and keeps every link, claim and unsent upload', async () => {
    const { db, world } = await expandedDatabase();
    try {
      // Before: the columns, the two keys to messages, the check and the indexes are there.
      expect(await columnsOfAttachments(db)).toContain('message_id');
      expect(await columnsOfAttachments(db)).toContain('channel_id');
      expect(await namesOfAttachmentsKeys(db)).toEqual([
        'attachments_channel_iff_message',
        'attachments_message_channel_fkey',
        'attachments_message_workspace_fkey',
        'idx_attachments_channel',
        'idx_attachments_message',
        'idx_attachments_unattached',
      ]);
      const linksBefore = await linksOf(db);
      expect(linksBefore).toHaveLength(2);

      const after = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(after.error).toBeUndefined();
      expect(after.results?.map((result) => result.migrationName)).toEqual([
        CONTRACT_MIGRATION,
        'chat/0006_channel_departures',
        'chat/0007_read_scopes',
        'chat/0008_unread_history_range',
        'chat/0009_thread_read_baseline',
        'chat/0010_membership_read_scopes',
        'chat/0011_personal_channel_groups',
        'chat/0012_removed_membership_scope',
        'chat/0013_missed_mail_claims',
        'chat/0014_shared_catalogue',
        'chat/0015_shared_source_changes',
        'chat/0016_shared_source_indexes',
        'chat/0017_deferred_author_session',
        'chat/0018_channel_access_sources',
      ]);

      expect(await columnsOfAttachments(db)).toEqual([
        'claimed_at',
        'created_at',
        'file_name',
        'height',
        'id',
        'kind',
        'mime_type',
        'size_bytes',
        'storage_key',
        'thumbnail_key',
        'uploader_id',
        'width',
        'workspace_id',
      ]);
      expect(await namesOfAttachmentsKeys(db)).toEqual([]);
      // The core's other keys, and the index the sweep reads, stay.
      const kept = await sql<{ name: string }>`
        select indexname as name from pg_indexes
        where schemaname = current_schema() and indexname = 'idx_attachments_unclaimed'`.execute(
        db,
      );
      expect(kept.rows).toHaveLength(1);

      expect(await linksOf(db)).toEqual(linksBefore);
      const claimed = await sql<{ id: string; claimed: boolean }>`
        select id, claimed_at is not null as claimed from attachments order by id`.execute(db);
      expect(claimed.rows).toEqual(
        [
          { id: world.sent, claimed: true },
          { id: world.keptByTombstone, claimed: true },
          { id: world.unsent, claimed: false },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      );

      // Starting again changes nothing.
      const again = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(again.error).toBeUndefined();
      expect(again.results).toEqual([]);

      // No key runs from the core's table to chat's any more: a message deleted takes its link and leaves the
      // file for chat's commands to drop (`dropMessageFiles`), which every path that deletes messages calls.
      await sql`delete from messages where id = ${world.liveMessage}`.execute(db);
      expect(await linksOf(db)).toEqual([world.keptByTombstone]);
      const rowLeft = await sql`select 1 from attachments where id = ${world.sent}`.execute(db);
      expect(rowLeft.rows).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  test('refuses, changing nothing, when a sent file has no link, and goes through once it has', async () => {
    const { db, world } = await expandedDatabase();
    try {
      // A send that did not write the link, as a database that skipped the release with the dual write has.
      await sql`delete from message_attachments where attachment_id = ${world.keptByTombstone}`.execute(
        db,
      );

      const refused = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(String(refused.error)).toContain('chat/0005 refused: 1 attachment(s)');
      expect(await columnsOfAttachments(db)).toContain('message_id');
      expect(await columnsOfAttachments(db)).toContain('channel_id');
      expect(await namesOfAttachmentsKeys(db)).toHaveLength(6);
      const recorded = await sql<{ name: string }>`
        select name from kysely_migration where name = ${CONTRACT_MIGRATION}`.execute(db);
      expect(recorded.rows).toEqual([]);

      // Still refused when it is run again; the data is untouched.
      const stillRefused = await migrateToLatest(db, undefined, {
        modules: PRODUCT_MIGRATION_SETS,
      });
      expect(String(stillRefused.error)).toContain('chat/0005 refused');
      expect(await linksOf(db)).toEqual([world.sent]);

      // The link written, it runs.
      await sql`
        insert into message_attachments (attachment_id, workspace_id, message_id, channel_id)
        values (${world.keptByTombstone}, ${world.workspace}, ${world.deletedMessage}, ${world.channel})`.execute(
        db,
      );
      const done = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(done.error).toBeUndefined();
      expect(await columnsOfAttachments(db)).not.toContain('message_id');
    } finally {
      await db.destroy();
    }
  });

  test('refuses a link that names another message than the file does, and a sent file that is not claimed', async () => {
    const mismatched = await expandedDatabase();
    try {
      await sql`
        update message_attachments set message_id = ${mismatched.world.deletedMessage}
        where attachment_id = ${mismatched.world.sent}`.execute(mismatched.db);
      const refused = await migrateToLatest(mismatched.db, undefined, {
        modules: PRODUCT_MIGRATION_SETS,
      });
      expect(String(refused.error)).toContain('chat/0005 refused: 1 attachment(s)');
    } finally {
      await mismatched.db.destroy();
    }

    // Linked and carried, but unclaimed: the sweep would take it for an upload nobody sent.
    const unclaimed = await expandedDatabase();
    try {
      await sql`update attachments set claimed_at = null where id = ${unclaimed.world.sent}`.execute(
        unclaimed.db,
      );
      const refused = await migrateToLatest(unclaimed.db, undefined, {
        modules: PRODUCT_MIGRATION_SETS,
      });
      expect(String(refused.error)).toContain('chat/0005 refused: 1 attachment(s)');
      expect(await columnsOfAttachments(unclaimed.db)).toContain('message_id');
    } finally {
      await unclaimed.db.destroy();
    }
  });

  test('counts every file that is not safe to drop the columns over, once each', async () => {
    const { db, world } = await expandedDatabase();
    try {
      // One file lost its link; the other is linked to another message than its own and is also unclaimed. Two
      // files, counted by file and never twice for failing two conditions.
      await sql`delete from message_attachments where attachment_id = ${world.keptByTombstone}`.execute(
        db,
      );
      await sql`
        update message_attachments set message_id = ${world.deletedMessage}
        where attachment_id = ${world.sent}`.execute(db);
      await sql`update attachments set claimed_at = null where id = ${world.sent}`.execute(db);

      const refused = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(String(refused.error)).toContain('chat/0005 refused: 2 attachment(s)');
      expect(await columnsOfAttachments(db)).toContain('message_id');
    } finally {
      await db.destroy();
    }
  });

  test('can be run again from its top after a crash: every statement is safe on a database already contracted', async () => {
    const { db } = await expandedDatabase();
    try {
      const done = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(done.error).toBeUndefined();
      const statements = splitStatements(
        readFileSync(join(MIGRATIONS_DIRECTORY, 'chat', CONTRACT_STARTS_AT), 'utf8'),
      );
      expect(statements.length).toBeGreaterThan(5);
      for (const statement of statements) await sql.raw(statement).execute(db);
      expect(await columnsOfAttachments(db)).not.toContain('message_id');
    } finally {
      await db.destroy();
    }
  });
});

describe('integration: the matrix of sets around the contract', () => {
  test('the core alone keeps the columns, inert; a later start with chat links, then drops them', async () => {
    const db = open(await emptyDatabase());
    try {
      // The core alone: a server that does not run chat has an `attachments` table with the two columns it
      // never writes, and chat's link table is not made.
      const coreOnly = await migrateToLatest(db, undefined, { modules: setsNamedBy('none') });
      expect(coreOnly.error).toBeUndefined();
      expect(await columnsOfAttachments(db)).toContain('message_id');
      expect(await columnsOfAttachments(db)).toContain('channel_id');
      const table = await sql`select to_regclass('message_attachments') as name`.execute(db);
      expect(table.rows).toEqual([{ name: null }]);

      // Files sent while chat ran in an older release, in the columns only, claimed.
      const at = new Date('2026-10-03T12:00:00.000Z');
      const { rows: people } = await sql<{ id: string }>`
        insert into users (email, username, display_name) values ('c@example.test', 'c', 'C') returning id`.execute(
        db,
      );
      const user = people[0]?.id ?? '';
      const { rows: spaces } = await sql<{ id: string }>`
        insert into workspaces (name, slug, created_by) values ('W', 'w3', ${user}) returning id`.execute(
        db,
      );
      const workspace = spaces[0]?.id ?? '';
      const { rows: rooms } = await sql<{ id: string }>`
        insert into channels (workspace_id, name, created_by) values (${workspace}, 'general', ${user}) returning id`.execute(
        db,
      );
      const channel = rooms[0]?.id ?? '';
      const message = Bun.randomUUIDv7('hex', at);
      const file = Bun.randomUUIDv7('hex', new Date(at.getTime() + 1));
      await sql`
        insert into messages (id, workspace_id, channel_id, sender_id, content, created_at)
        values (${message}, ${workspace}, ${channel}, ${user}, 'x', ${at})`.execute(db);
      await sql`
        insert into attachments (id, workspace_id, uploader_id, storage_key, file_name, mime_type, size_bytes,
                                 message_id, channel_id, claimed_at)
        values (${file}, ${workspace}, ${user}, ${`k/${file}`}, 'f.txt', 'text/plain', 10, ${message}, ${channel}, ${at})`.execute(
        db,
      );

      // Chat started later: its set runs in order, so the backfill reads the columns before they are dropped.
      const withChat = await migrateToLatest(db, undefined, { modules: setsNamedBy('chat') });
      expect(withChat.error).toBeUndefined();
      expect(withChat.results?.map((result) => result.migrationName)).toEqual([
        'chat/0001_message_attachments',
        'chat/0002_scheduled_messages',
        'chat/0003_message_reminders',
        'chat/0004_hidden_messages',
        CONTRACT_MIGRATION,
        'chat/0006_channel_departures',
        'chat/0007_read_scopes',
        'chat/0008_unread_history_range',
        'chat/0009_thread_read_baseline',
        'chat/0010_membership_read_scopes',
        'chat/0011_personal_channel_groups',
        'chat/0012_removed_membership_scope',
        'chat/0013_missed_mail_claims',
        'chat/0014_shared_catalogue',
        'chat/0015_shared_source_changes',
        'chat/0016_shared_source_indexes',
        'chat/0017_deferred_author_session',
        'chat/0018_channel_access_sources',
      ]);
      expect(await linksOf(db)).toEqual([file]);
      expect(await columnsOfAttachments(db)).not.toContain('message_id');
    } finally {
      await db.destroy();
    }
  });

  test('a fresh database with every set has no key from the core to chat', async () => {
    const db = open(await emptyDatabase());
    try {
      const fresh = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(fresh.error).toBeUndefined();
      expect(await columnsOfAttachments(db)).not.toContain('message_id');
      expect(await namesOfAttachmentsKeys(db)).toEqual([]);
    } finally {
      await db.destroy();
    }
  });
});

describe('integration: moving development read scopes into chat’s own table', () => {
  test(
    'preserves an explicit scope and receipt, leaves an unknown legacy scope absent, and changes no final core column',
    async () => {
      const name = await emptyDatabase();
      const db = open(name);
      try {
        const sets = PRODUCT_MIGRATION_SETS.map((set) => ({
          ...set,
          directory:
            set.id === 'chat'
              ? copiedBelow(set.directory, '0010_membership_read_scopes.sql')
              : set.directory,
        }));
        expect((await migrateToLatest(db, undefined, { modules: sets })).error).toBeUndefined();
        const at = new Date('2026-11-07T12:00:00.000Z');
        const root = Bun.randomUUIDv7('hex', at);
        const cursor = Bun.randomUUIDv7('hex', new Date(at.getTime() + 1));
        const people = await sql<{ id: string }>`insert into users(email, username, display_name)
        values ('known@test.invalid', 'known', 'Known'), ('legacy@test.invalid', 'legacy', 'Legacy') returning id`.execute(
          db,
        );
        const [known, legacy] = people.rows;
        if (known === undefined || legacy === undefined) throw new Error('Missing people');
        const spaces = await sql<{
          id: string;
        }>`insert into workspaces(name, slug) values ('Ops', 'scope') returning id`.execute(db);
        const workspace = spaces.rows[0];
        if (workspace === undefined) throw new Error('Missing workspace');
        const channels = await sql<{
          id: string;
        }>`insert into channels(workspace_id, name) values (${workspace.id}, 'handover') returning id`.execute(
          db,
        );
        const channel = channels.rows[0];
        if (channel === undefined) throw new Error('Missing channel');
        await sql`insert into messages(id, workspace_id, channel_id, sender_id, content)
        values (${root}, ${workspace.id}, ${channel.id}, ${known.id}, 'Root')`.execute(db);
        await sql`insert into channel_members(channel_id, user_id, unread_since, unread_history_from, thread_read_baseline_id)
        values (${channel.id}, ${known.id}, ${at}, ${root}, ${cursor}), (${channel.id}, ${legacy.id}, null, null, null)`.execute(
          db,
        );
        await sql`insert into thread_reads(channel_id, user_id, root_id, last_read_message_id, read_at)
        values (${channel.id}, ${known.id}, ${root}, ${cursor}, ${at})`.execute(db);
        const after = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
        expect(after.error).toBeUndefined();
        expect(after.results?.map((result) => result.migrationName)).toEqual([
          'chat/0010_membership_read_scopes',
          'chat/0011_personal_channel_groups',
          'chat/0012_removed_membership_scope',
          'chat/0013_missed_mail_claims',
          'chat/0014_shared_catalogue',
          'chat/0015_shared_source_changes',
          'chat/0016_shared_source_indexes',
          'chat/0017_deferred_author_session',
          'chat/0018_channel_access_sources',
        ]);
        expect((await sql`select * from channel_read_scopes`.execute(db)).rows).toEqual([
          {
            channel_id: channel.id,
            user_id: known.id,
            unread_since: at,
            unread_history_from: root,
            thread_read_baseline_id: cursor,
          },
        ]);
        expect((await sql`select last_read_message_id from thread_reads`.execute(db)).rows).toEqual(
          [{ last_read_message_id: cursor }],
        );
        const columns = await sql<{
          name: string;
        }>`select column_name as name from information_schema.columns
        where table_name = 'channel_members' and column_name in ('unread_since', 'unread_history_from', 'thread_read_baseline_id')`.execute(
          db,
        );
        expect(columns.rows).toEqual([]);
        await sql`delete from channel_members where channel_id = ${channel.id} and user_id = ${known.id}`.execute(
          db,
        );
        expect((await sql`select * from channel_read_scopes`.execute(db)).rows).toEqual([]);
        expect((await sql`select * from thread_reads`.execute(db)).rows).toEqual([]);
      } finally {
        await db.destroy();
      }
    },
    CLONE_HOOK_MS,
  );
});
