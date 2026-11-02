/**
 * Migration 0063 on rows that were there before it (D-225): every channel and direct message already
 * there follows its workspace — no floor, not forever — the check ends up validated, and running the file
 * again changes nothing, as a file that leaves its transaction promises (D-86). Then what the check
 * refuses, each by its name: a floor under the workspace's own 30, a floor beside forever, and any of it
 * on a direct message.
 *
 * The file runs here statement by statement inside the test's transaction; the migrator runs it whole.
 * Each refusal is tried behind a savepoint, since a refused statement aborts the transaction around it.
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

// A database of its own (D-228): migration 0063's statements lock whole tables, and on the shared database a
// rollback holding them deadlocks with every other file running beside it.
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
  readFileSync(join(MIGRATIONS_DIRECTORY, '0063_channel_retention.sql'), 'utf8'),
);

const CHECK = '23514';
const CONSTRAINT = 'channels_retention_sane';

const migrate = async (db: Executor): Promise<void> => {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
};

/** A workspace with a channel and a direct message in it, as they were before 0063. */
const before0063 = async (db: Executor): Promise<{ channelId: string; directId: string }> => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'r', slug: `r-${suffix}`, retention_days: 30 })
    .returning('id')
    .executeTakeFirstOrThrow();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const people = [crypto.randomUUID(), crypto.randomUUID()].sort();
  const direct = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, type: 'direct_message', dm_key: people.join(':') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await sql
    .raw(
      `ALTER TABLE channels DROP CONSTRAINT ${CONSTRAINT}, DROP COLUMN min_retention_days, DROP COLUMN retain_forever`,
    )
    .execute(db);
  return { channelId: channel.id, directId: direct.id };
};

const retentionOf = async (db: Executor, id: string): Promise<unknown> =>
  (
    await sql<{
      min_retention_days: number | null;
      retain_forever: boolean;
    }>`select min_retention_days, retain_forever from channels where id = ${id}`.execute(db)
  ).rows[0];

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

describe('integration: migration 0063 on the rows already there', () => {
  test('every channel already there follows its workspace, and the check holds', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0063(db);

      await migrate(db);

      for (const id of [world.channelId, world.directId]) {
        expect(await retentionOf(db, id)).toEqual({
          min_retention_days: null,
          retain_forever: false,
        });
      }
      expect(await validated(db)).toEqual([true]);
    });
  });

  test('run again, it changes nothing and refuses nothing', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0063(db);
      await migrate(db);
      await db
        .updateTable('channels')
        .set({ retain_forever: true })
        .where('id', '=', world.channelId)
        .execute();

      await migrate(db);

      expect(await retentionOf(db, world.channelId)).toEqual({
        min_retention_days: null,
        retain_forever: true,
      });
      expect(await validated(db)).toEqual([true]);
    });
  });

  test('the check refuses a floor under 30, a floor beside forever, and either on a direct message', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0063(db);
      await migrate(db);
      const set = async (
        id: string,
        values: { min_retention_days?: number | null; retain_forever?: boolean },
      ): Promise<string> =>
        await outcome(db, async () => {
          await db.updateTable('channels').set(values).where('id', '=', id).execute();
        });
      const refused = `${CHECK} ${CONSTRAINT}`;

      expect(await set(world.channelId, { min_retention_days: 29 })).toBe(refused);
      expect(await set(world.channelId, { min_retention_days: 30 })).toBe('accepted');
      expect(await set(world.channelId, { retain_forever: true })).toBe(refused);
      expect(await set(world.channelId, { min_retention_days: null, retain_forever: true })).toBe(
        'accepted',
      );
      expect(await set(world.directId, { retain_forever: true })).toBe(refused);
      expect(await set(world.directId, { min_retention_days: 365 })).toBe(refused);
    });
  });
});
