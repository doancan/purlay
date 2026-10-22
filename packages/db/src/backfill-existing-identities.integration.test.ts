/**
 * Migration 0055 against rows shaped as an install from before the sign-in library left them (D-179 §7):
 * a GitHub person gains the `accounts` row the library finds them by, once and with no token; a person
 * who existed before 0047 and proved their address is marked so; anybody made since, or erased, is not.
 * Run on the current schema inside a transaction that is rolled back (D-46): the statements are
 * idempotent, so running them where they already ran is the case that matters.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import type { Database } from './index';
import { closeIntegrationDatabase, withRollback } from './testing';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const MIGRATION = readFileSync(
  new URL('../migrations/0055_backfill_existing_identities.sql', import.meta.url),
  'utf8',
);

const BEFORE = new Date('2020-01-01T00:00:00Z');
const unique = (floor: number): number => Math.floor(Math.random() * 1_000_000_000) + floor;

const person = async (
  db: Kysely<Database>,
  name: string,
  over: { github_id?: number; deleted?: boolean; created_at?: Date } = {},
): Promise<string> =>
  (
    await db
      .insertInto('users')
      .values({
        email: `${name}@example.test`,
        username: name,
        display_name: name,
        github_id: over.github_id ?? null,
        deleted_at: over.deleted === true ? new Date() : null,
        ...(over.created_at === undefined ? {} : { created_at: over.created_at }),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

describe('integration: 0055 backfill_existing_identities', () => {
  test('gives a GitHub person an account row, once, with no token, and nobody else one', async () => {
    await withRollback(async (db) => {
      const id = unique(1_000_000_000);
      const github = await person(db, 'backfill-gh', { github_id: id, created_at: BEFORE });
      const already = await person(db, 'backfill-has', { github_id: id + 1, created_at: BEFORE });
      const mail = await person(db, 'backfill-mail', { created_at: BEFORE });
      await db
        .insertInto('accounts')
        .values({ user_id: already, provider_id: 'github', account_id: String(id + 1) })
        .execute();

      await sql.raw(MIGRATION).execute(db);
      await sql.raw(MIGRATION).execute(db);

      const rows = await db
        .selectFrom('accounts')
        .selectAll()
        .where('user_id', 'in', [github, already, mail])
        .execute();
      const of = (user: string): typeof rows => rows.filter((row) => row.user_id === user);
      expect(of(github)).toHaveLength(1);
      expect(of(github)[0]).toMatchObject({
        provider_id: 'github',
        account_id: String(id),
        access_token: null,
        refresh_token: null,
        id_token: null,
        password: null,
      });
      expect(of(already)).toHaveLength(1);
      expect(of(mail)).toHaveLength(0);
    });
  });

  test('does not stop on a GitHub id another account row already holds', async () => {
    await withRollback(async (db) => {
      const id = unique(2_000_000_000);
      const holder = await person(db, 'backfill-holder');
      const claimant = await person(db, 'backfill-claimant', { github_id: id });
      await db
        .insertInto('accounts')
        .values({ user_id: holder, provider_id: 'github', account_id: String(id) })
        .execute();

      await sql.raw(MIGRATION).execute(db);

      const rows = await db
        .selectFrom('accounts')
        .select('user_id')
        .where('account_id', '=', String(id))
        .execute();
      expect(rows.map((row) => row.user_id)).toEqual([holder]);
      expect(claimant).not.toBe(holder);
    });
  });

  test('marks the address of a person from before 0047 proven, and no one else', async () => {
    await withRollback(async (db) => {
      const old = await person(db, 'backfill-old', { created_at: BEFORE });
      const gone = await person(db, 'backfill-erased', { created_at: BEFORE, deleted: true });
      const since = await person(db, 'backfill-since');

      await sql.raw(MIGRATION).execute(db);

      const verified = async (id: string): Promise<boolean> =>
        (
          await db
            .selectFrom('users')
            .select('email_verified')
            .where('id', '=', id)
            .executeTakeFirstOrThrow()
        ).email_verified;
      expect(await verified(old)).toBe(true);
      expect(await verified(gone)).toBe(false);
      expect(await verified(since)).toBe(false);
    });
  });
});
