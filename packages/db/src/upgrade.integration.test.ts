/**
 * What a database that last ran the release before this one becomes when it starts the next (D-250, D-86).
 *
 * The sets of the modules are applied after the core's, and a module's table is made from the core's: so the
 * state that matters is not an empty database but one with rows in it. This builds the previous release's schema
 * from the migration files below the first one of this release, puts attachments in it as that release wrote them
 * — some sent with a message, some not — and migrates to head the way a process does, with the core's directory and
 * every module's set. What was linked is linked, what was not is not, and the keys keep what they kept.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { MIGRATIONS_DIRECTORY, migrateToLatest, PRODUCT_MIGRATION_SETS } from './migrator';
import { closeIntegrationDatabase } from './testing';

/** The first migration of this release: everything before it is the previous release's schema. */
const THIS_RELEASE_STARTS_AT = '0079_attachment_claims.sql';

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

afterAll(async () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  const admin = open('postgres');
  for (const name of databases) {
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
  }
  await admin.destroy();
  await closeIntegrationDatabase();
});

/** The previous release's migrations, copied where they can be applied alone. */
const previousRelease = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-previous-release-'));
  directories.push(directory);
  for (const file of readdirSync(MIGRATIONS_DIRECTORY)) {
    if (file.endsWith('.sql') && file < THIS_RELEASE_STARTS_AT) {
      copyFileSync(join(MIGRATIONS_DIRECTORY, file), join(directory, file));
    }
  }
  return directory;
};

/**
 * An empty database of its own. Not a schema in the shared one: the migrations name the extensions they use
 * (trigram, GIN) and drop and make tables by bare name, so a search path that reached the shared schema would reach its
 * tables too.
 */
const emptyDatabase = async (): Promise<string> => {
  const name = `upgrade_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = open('postgres');
  try {
    await sql`create database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  databases.push(name);
  return name;
};

describe('integration: upgrading from the previous release', () => {
  test('claims what was sent, links it in chat’s own table, and leaves the rest unclaimed', async () => {
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

      // Migrated the way a process migrates: the core's files, then each module's set.
      const after = await migrateToLatest(db, undefined, { modules: PRODUCT_MIGRATION_SETS });
      expect(after.error).toBeUndefined();
      expect(after.results?.map((result) => result.migrationName)).toEqual([
        '0079_attachment_claims',
        '0080_away_chosen',
        '0081_message_search_branches',
        'chat/0001_message_attachments',
        'chat/0002_scheduled_messages',
        'chat/0003_message_reminders',
        'chat/0004_hidden_messages',
        'issues/0001_issues',
      ]);

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
