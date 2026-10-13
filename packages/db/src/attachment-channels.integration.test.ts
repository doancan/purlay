/**
 * Migration 0027 on rows that were there before it (D-129): an attachment linked before the column
 * existed is given its message's channel, one never sent is left without, the constraints end up
 * validated — and running the file again changes nothing, as a file that leaves its transaction
 * promises (D-86).
 *
 * The file runs here statement by statement inside the test's transaction, without the index built
 * `CONCURRENTLY`, which a transaction refuses; the migrator itself runs it whole in every database.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import type { Executor } from './client';
import { MIGRATIONS_DIRECTORY } from './migrator';
import { splitStatements } from './statements';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const STATEMENTS = splitStatements(
  readFileSync(join(MIGRATIONS_DIRECTORY, '0027_attachment_channels.sql'), 'utf8'),
).filter((statement) => !statement.includes('CONCURRENTLY'));

const CONSTRAINTS = ['attachments_channel_iff_message', 'attachments_message_channel_fkey'];

const migrate = async (db: Executor): Promise<void> => {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
};

/** A workspace, a channel, a message in it, and two uploads: one linked to the message, one not. */
const before0027 = async (
  db: Executor,
): Promise<{ channelId: string; linked: string; unsent: string }> => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db
    .insertInto('users')
    .values({ email: `m-${suffix}@example.test`, username: `m-${suffix}`, display_name: 'M' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'm', slug: `m-${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const id = async (): Promise<string> =>
    (await sql<{ id: string }>`select uuidv7() as id`.execute(db)).rows[0]?.id ?? '';
  const message = await id();
  await db
    .insertInto('messages')
    .values({
      id: message,
      workspace_id: workspace.id,
      channel_id: channel.id,
      sender_id: user.id,
      content: 'look',
    })
    .execute();
  // What the table was before 0027: no constraint over the channel, and none set.
  for (const name of CONSTRAINTS) {
    await sql.raw(`ALTER TABLE attachments DROP CONSTRAINT ${name}`).execute(db);
  }
  const upload = async (messageId: string | null): Promise<string> => {
    const attachment = await id();
    await db
      .insertInto('attachments')
      .values({
        id: attachment,
        workspace_id: workspace.id,
        uploader_id: user.id,
        message_id: messageId,
        storage_key: `w/${workspace.id}/${attachment}`,
        file_name: 'a.bin',
        mime_type: 'application/octet-stream',
        size_bytes: '1',
      })
      .execute();
    return attachment;
  };
  return { channelId: channel.id, linked: await upload(message), unsent: await upload(null) };
};

const channelOf = async (db: Executor, attachmentId: string): Promise<string | null> =>
  (
    await db
      .selectFrom('attachments')
      .select('channel_id')
      .where('id', '=', attachmentId)
      .executeTakeFirstOrThrow()
  ).channel_id;

const validated = async (db: Executor): Promise<Record<string, boolean>> => {
  const { rows } = await sql<{ conname: string; convalidated: boolean }>`
    select conname, convalidated from pg_constraint
    where conrelid = 'attachments'::regclass and conname in (${sql.join(CONSTRAINTS)})
  `.execute(db);
  return Object.fromEntries(rows.map((row) => [row.conname, row.convalidated]));
};

describe('integration: migration 0027 on the rows already there', () => {
  test('a sent file is given its message’s channel, an unsent one none, and both checks hold', async () => {
    await withRollback(async (db) => {
      const world = await before0027(db);
      expect(await channelOf(db, world.linked)).toBeNull();

      await migrate(db);

      expect(await channelOf(db, world.linked)).toBe(world.channelId);
      expect(await channelOf(db, world.unsent)).toBeNull();
      expect(await validated(db)).toEqual({
        attachments_channel_iff_message: true,
        attachments_message_channel_fkey: true,
      });
    });
  });

  test('run again, it changes nothing and refuses nothing', async () => {
    await withRollback(async (db) => {
      const world = await before0027(db);
      await migrate(db);

      await migrate(db);

      expect(await channelOf(db, world.linked)).toBe(world.channelId);
      expect(await channelOf(db, world.unsent)).toBeNull();
      expect(Object.keys(await validated(db))).toHaveLength(2);
    });
  });
});
