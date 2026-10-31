/**
 * Migration 0064 on rows that were there before it (D-231 §1): a delivery recorded before the column
 * existed keeps its row with no digest, and two such rows of one feed do not collide; the check ends up
 * validated, and running the file again changes nothing, as a file that leaves its transaction promises
 * (D-86). Then what the table refuses: a digest that is not one, and one body twice for one feed — while
 * the same body for another feed is that feed's.
 *
 * The file runs here statement by statement inside the test's transaction, its index built without
 * `CONCURRENTLY`, which a transaction refuses; the migrator runs it whole in every database. Each refusal
 * is tried behind a savepoint, since a refused statement aborts the transaction around it.
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
} from './testing';

// A database of its own (D-228): migration 0064's statements lock the table, and on the shared database a
// rollback holding them deadlocks with every other file running beside it.
let own: ClonedDatabase;
beforeAll(async () => {
  own = await cloneIntegrationDatabase();
});
const inOwnDatabase = async (body: Parameters<typeof withRollback>[0]): Promise<void> => {
  await withRollback(body, own.db);
};

afterAll(async () => {
  await own.drop();
  await closeIntegrationDatabase();
});

const STATEMENTS = splitStatements(
  readFileSync(join(MIGRATIONS_DIRECTORY, '0064_github_delivery_bodies.sql'), 'utf8'),
).map((statement) => statement.replaceAll(' CONCURRENTLY', ''));

const CHECK = 'github_deliveries_body_is_a_digest';
const UNIQUE = 'github_deliveries_feed_body_key';

const migrate = async (db: Executor): Promise<void> => {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
};

const DIGEST = 'ab'.repeat(32);

/** Two feeds, and two deliveries the first one recorded before 0064. */
const before0064 = async (db: Executor): Promise<{ feedId: string; otherFeedId: string }> => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'g', slug: `g-${suffix}` })
    .returning('id')
    .executeTakeFirstOrThrow();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'deploys', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const feed = async (repository: string): Promise<string> =>
    (
      await db
        .insertInto('github_repo_feeds')
        .values({
          id: crypto.randomUUID(),
          workspace_id: workspace.id,
          channel_id: channel.id,
          repository_full_name: repository,
          events: ['push'],
          secret_encrypted: 'sealed',
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const feedId = await feed('acme/api');
  const otherFeedId = await feed('acme/web');
  await sql.raw(`DROP INDEX ${UNIQUE}`).execute(db);
  await sql.raw('ALTER TABLE github_deliveries DROP COLUMN body_digest').execute(db);
  await sql`insert into github_deliveries (feed_id, delivery_id)
    values (${feedId}, 'before-1'), (${feedId}, 'before-2')`.execute(db);
  return { feedId, otherFeedId };
};

const digestsOf = async (db: Executor, feedId: string): Promise<unknown[]> =>
  (
    await sql<{ delivery_id: string; body_digest: string | null }>`
      select delivery_id, body_digest from github_deliveries
      where feed_id = ${feedId} order by delivery_id`.execute(db)
  ).rows;

const validated = async (db: Executor): Promise<boolean[]> =>
  (
    await sql<{ convalidated: boolean }>`
      select convalidated from pg_constraint
      where conrelid = 'github_deliveries'::regclass and conname = ${CHECK}
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

describe('integration: migration 0064 on the rows already there', () => {
  test('every delivery already there stays, with no digest, and the check holds', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0064(db);

      await migrate(db);

      expect(await digestsOf(db, world.feedId)).toEqual([
        { delivery_id: 'before-1', body_digest: null },
        { delivery_id: 'before-2', body_digest: null },
      ]);
      expect(await validated(db)).toEqual([true]);
    });
  });

  test('run again, it changes nothing and refuses nothing', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0064(db);
      await migrate(db);
      await db
        .insertInto('github_deliveries')
        .values({ feed_id: world.feedId, delivery_id: 'after', body_digest: DIGEST })
        .execute();

      await migrate(db);

      expect(await digestsOf(db, world.feedId)).toEqual([
        { delivery_id: 'after', body_digest: DIGEST },
        { delivery_id: 'before-1', body_digest: null },
        { delivery_id: 'before-2', body_digest: null },
      ]);
      expect(await validated(db)).toEqual([true]);
    });
  });

  test('a digest is 64 hex digits, and one body is one delivery of a feed', async () => {
    await inOwnDatabase(async (db) => {
      const world = await before0064(db);
      await migrate(db);
      const record = async (feedId: string, deliveryId: string, digest: string): Promise<string> =>
        await outcome(db, async () => {
          await db
            .insertInto('github_deliveries')
            .values({ feed_id: feedId, delivery_id: deliveryId, body_digest: digest })
            .execute();
        });

      expect(await record(world.feedId, 'upper', 'AB'.repeat(32))).toBe(`23514 ${CHECK}`);
      expect(await record(world.feedId, 'short', 'ab'.repeat(31))).toBe(`23514 ${CHECK}`);
      expect(await record(world.feedId, 'first', DIGEST)).toBe('accepted');
      expect(await record(world.feedId, 'replayed', DIGEST)).toBe(`23505 ${UNIQUE}`);
      expect(await record(world.otherFeedId, 'first', DIGEST)).toBe('accepted');
    });
  });
});
