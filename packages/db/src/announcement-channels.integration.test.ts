/**
 * Migration 0072 on rows that were there before it (D-243): every channel and direct message already
 * there takes a root from anybody in it, the check ends up validated, and running the file again changes
 * nothing, as a file that leaves its transaction promises (D-86). Then what the check refuses: the flag on
 * a direct message, which is its people and is configured by nobody.
 *
 * The file runs here statement by statement inside the test's transaction; the migrator runs it whole.
 * The refusal is tried behind a savepoint, since a refused statement aborts the transaction around it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'kysely';
import pg from 'pg';
import type { Executor } from './client';
import { MIGRATIONS_DIRECTORY } from './migrator';
import { splitStatements } from './statements';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from './testing';

// A database of its own (D-228): the migration's statements lock the whole table, and on the shared
// database a rollback holding them deadlocks with every other file running beside it.
let own: ClonedDatabase;
beforeAll(async () => {
  own = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
const inOwnDatabase = async (body: Parameters<typeof withRollback>[0]): Promise<void> => {
  await withRollback(body, own.db);
};

afterAll(async () => {
  await own.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const STATEMENTS = splitStatements(
  readFileSync(join(MIGRATIONS_DIRECTORY, '0072_announcement_channels.sql'), 'utf8'),
);

const CONSTRAINT = 'channels_only_admins_post_not_dm';

const migrate = async (db: Executor): Promise<void> => {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
};

/** A workspace with a channel and a direct message in it, as they were before 0072. */
const before0072 = async (db: Executor): Promise<{ channelId: string; directId: string }> => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'a', slug: `a-${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'announcements', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const people = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const direct = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, type: 'direct_message', dm_key: people.join(':') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql
    .raw(`ALTER TABLE channels DROP CONSTRAINT ${CONSTRAINT}, DROP COLUMN only_admins_post`)
    .execute(db);
  return { channelId: channel.id, directId: direct.id };
};

const flagOf = async (db: Executor, id: string): Promise<boolean | undefined> =>
  (
    await sql<{
      only_admins_post: boolean;
    }>`select only_admins_post from channels where id = ${id}`.execute(db)
  ).rows[0]?.only_admins_post;

const validated = async (db: Executor): Promise<boolean[]> =>
  (
    await sql<{ convalidated: boolean }>`
      select convalidated from pg_constraint
      where conrelid = 'channels'::regclass and conname = ${CONSTRAINT}
    `.execute(db)
  ).rows.map((row) => row.convalidated);

/** What the database said to a write, or `accepted`; the transaction is left as it was before it. */
const outcome = async (db: Executor, write: () => Promise<unknown>): Promise<string> => {
  await sql`savepoint attempt`.execute(db);
  try {
    await write();
    await sql`release savepoint attempt`.execute(db);
    return 'accepted';
  } catch (error) {
    await sql`rollback to savepoint attempt`.execute(db);
    if (error instanceof pg.DatabaseError) return `${error.code ?? ''} ${error.constraint ?? ''}`;
    throw error;
  }
};

describe('integration: migration 0072 on the rows already there', () => {
  test('every channel already there takes a root from anybody in it, and the check holds', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0072(db);

      await migrate(db);

      expect(await flagOf(db, world.channelId)).toBe(false);
      expect(await flagOf(db, world.directId)).toBe(false);
      expect(await validated(db)).toEqual([true]);
    });
  });

  test('run again, it changes nothing and refuses nothing', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0072(db);
      await migrate(db);
      await db
        .updateTable('channels')
        .set({ only_admins_post: true })
        .where('id', '=', world.channelId)
        .execute();

      await migrate(db);

      expect(await flagOf(db, world.channelId)).toBe(true);
      expect(await validated(db)).toEqual([true]);
    });
  });

  test('the check refuses the flag on a direct message, and lets a channel have it', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0072(db);
      await migrate(db);
      const set = async (id: string): Promise<string> =>
        await outcome(db, async () => {
          await db
            .updateTable('channels')
            .set({ only_admins_post: true })
            .where('id', '=', id)
            .execute();
        });

      expect(await set(world.directId)).toBe(`23514 ${CONSTRAINT}`);
      expect(await set(world.channelId)).toBe('accepted');
    });
  });
});
