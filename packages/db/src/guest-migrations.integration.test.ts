/** Guest expansion/resume on real pre-guest rows, outside rollback transactions (D-86, D-300). */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { MIGRATIONS_DIRECTORY, migrateToLatest } from './migrator';
import { executableText, splitStatements } from './statements';
import {
  backendsGone,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  dropDatabases,
  DROP_HOOK_MS,
} from './testing';

const EXPANSION = '0099_workspace_guest_access.sql';
const ENCODING = '0100_guest_invitation_token_encoding.sql';
const DIRECTORY = '0101_workspace_guest_directory.sql';
const directories: string[] = [];
const databases: string[] = [];
const owner = Bun.randomUUIDv7();
const colleague = Bun.randomUUIDv7();
const workspace = Bun.randomUUIDv7();
const channel = Bun.randomUUIDv7();
const memberToken = 'ordinary-invitation-migration-fixture';
const guestToken = 'restricted-invitation-migration-fixture';
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
let template: string;
let expandedDirectory: string;
let latestDirectory: string;

/** A single physical connection per handle, so the observed PID is the waiting writer/builder. */
const open = (name: string): Kysely<unknown> => {
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${name}`;
  return new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 1 }),
    }),
  });
};

const copiedBelow = (end: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-guest-upgrade-'));
  directories.push(directory);
  for (const name of readdirSync(MIGRATIONS_DIRECTORY)) {
    if (name.endsWith('.sql') && name < end)
      copyFileSync(join(MIGRATIONS_DIRECTORY, name), join(directory, name));
  }
  return directory;
};

const emptyDatabase = async (source?: string): Promise<string> => {
  const name = `guest_upgrade_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = open('postgres');
  try {
    if (source === undefined) await sql`create database ${sql.id(name)}`.execute(admin);
    else await sql`create database ${sql.id(name)} template ${sql.id(source)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  databases.push(name);
  return name;
};

beforeAll(async () => {
  template = await emptyDatabase();
  expandedDirectory = copiedBelow(ENCODING);
  latestDirectory = copiedBelow('0102_');
  const db = open(template);
  try {
    expect((await migrateToLatest(db, copiedBelow(EXPANSION))).error).toBeUndefined();
    await sql`insert into users (id, email, username, display_name)
      values (${owner}, 'owner@example.test', 'owner', 'Owner'),
             (${colleague}, 'colleague@example.test', 'colleague', 'Colleague')`.execute(db);
    await sql`insert into workspaces (id, name, slug, created_by)
      values (${workspace}, 'Upgrade', 'upgrade', ${owner})`.execute(db);
    await sql`insert into workspace_members (workspace_id, user_id, role, joined_at)
      values (${workspace}, ${owner}, 'owner', '2026-11-01T12:00:00Z'),
             (${workspace}, ${colleague}, 'member', '2026-11-02T12:00:00Z')`.execute(db);
    await sql`insert into workspace_invitations
      (id, created_at, workspace_id, created_by, token_hash, expires_at)
      values ('019a0000-0000-7000-8001-000000000001', now(), ${workspace}, ${owner},
              ${digest(memberToken)}, now() + interval '1 hour')`.execute(db);
  } finally {
    await db.destroy();
  }
  expect(await backendsGone(template, 5_000)).toBe(true);
}, CLONE_HOOK_MS);

afterAll(async () => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  await dropDatabases(databases);
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const pidOf = async (db: Kysely<unknown>): Promise<number> => {
  const row = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0];
  if (row === undefined) throw new Error('Missing migration connection');
  return row.pid;
};

interface HeldWriter {
  readonly pid: number;
  readonly release: () => void;
  readonly completed: Promise<void>;
}

const holdWrite = async (
  db: Kysely<unknown>,
  write: (tx: Kysely<unknown>) => Promise<unknown>,
): Promise<HeldWriter> => {
  const entered = Promise.withResolvers<number>();
  const release = Promise.withResolvers<undefined>();
  const completed = db.transaction().execute(async (tx) => {
    await write(tx);
    entered.resolve(await pidOf(tx));
    await release.promise;
  });
  const pid = await Promise.race([
    entered.promise,
    completed.then(() => {
      throw new Error('Writer finished before the hold');
    }),
  ]);
  return {
    pid,
    release: (): void => {
      release.resolve(undefined);
    },
    completed,
  };
};

const blockedBy = async (
  observer: Kysely<unknown>,
  waiting: number,
  blocker: number,
): Promise<boolean> => {
  const until = performance.now() + 3_000;
  do {
    const row = (
      await sql<{ pids: number[] }>`select pg_blocking_pids(${waiting}) as pids`.execute(observer)
    ).rows[0];
    if (row?.pids.includes(blocker) === true) return true;
    await Bun.sleep(5);
  } while (performance.now() < until);
  return false;
};

/** Simulate a crash immediately before one real statement, without recording the file. */
const applyBefore = async (
  db: Kysely<unknown>,
  file: string,
  startsWith: string,
): Promise<string> => {
  for (const statement of splitStatements(readFileSync(join(MIGRATIONS_DIRECTORY, file), 'utf8'))) {
    if (executableText(statement).startsWith(startsWith)) return statement;
    await sql.raw(statement).execute(db);
  }
  throw new Error(`Missing migration boundary in ${file}`);
};

const errorCode = (error: unknown): string | undefined =>
  error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

/** Exactly the digest comparison an older unrestricted reader performs. */
const legacyLookup = async (db: Kysely<unknown>, token: string): Promise<boolean> =>
  (
    await sql<{ n: number }>`select count(*)::int as n from workspace_invitations
      where token_hash = ${digest(token)}`.execute(db)
  ).rows[0]?.n === 1;

describe('integration: safe guest migrations from the pre-guest schema', () => {
  test('partial expansion resumes, preserves ordinary rows and validates with an existing writer open', async () => {
    const name = await emptyDatabase(template);
    const db = open(name);
    const writer = open(name);
    try {
      const validation = await applyBefore(
        db,
        EXPANSION,
        'ALTER TABLE workspace_members VALIDATE CONSTRAINT',
      );
      const held = await holdWrite(
        writer,
        async (tx) =>
          await sql`update workspace_members set joined_at = joined_at
          where workspace_id = ${workspace} and user_id = ${owner}`.execute(tx),
      );
      try {
        await sql`set statement_timeout = '1s'`.execute(db);
        await sql.raw(validation).execute(db);
        const writerState = await sql<{ open: boolean }>`select xact_start is not null as open
          from pg_stat_activity where pid = ${held.pid}`.execute(db);
        expect(writerState.rows).toEqual([{ open: true }]);
      } finally {
        held.release();
        await held.completed;
        await sql`reset statement_timeout`.execute(db);
      }
      expect((await migrateToLatest(db, latestDirectory)).error).toBeUndefined();
      const members = await sql<{
        role: string;
        joined_at: Date;
        access_kind: string;
        guest_since: Date | null;
        guest_expires_at: Date | null;
        guest_modules: string[] | null;
      }>`select role, joined_at, access_kind, guest_since, guest_expires_at, guest_modules
        from workspace_members where workspace_id = ${workspace} order by joined_at`.execute(db);
      expect(members.rows).toEqual(
        [
          { role: 'owner', joined_at: new Date('2026-11-01T12:00:00Z') },
          { role: 'member', joined_at: new Date('2026-11-02T12:00:00Z') },
        ].map((row) => ({
          ...row,
          access_kind: 'member',
          guest_since: null,
          guest_expires_at: null,
          guest_modules: null,
        })),
      );
      expect(await legacyLookup(db, memberToken)).toBe(true);
      const validated = await sql<{ n: number; valid: number }>`select count(*)::int as n,
        count(*) filter (where convalidated)::int as valid from pg_constraint where conname in (
          'workspace_members_access_kind', 'workspace_members_guest_authority',
          'workspace_invitations_access_kind', 'workspace_invitations_guest_authority'
        )`.execute(db);
      expect(validated.rows).toEqual([{ n: 4, valid: 4 }]);
      const invalid = await sql`update workspace_members set guest_since = now()
        where workspace_id = ${workspace} and user_id = ${owner}`
        .execute(db)
        .then(() => undefined, errorCode);
      expect(invalid).toBe('23514');
      const repeated = await migrateToLatest(db, latestDirectory);
      expect(repeated.error).toBeUndefined();
      expect(repeated.results).toEqual([]);
    } finally {
      await writer.destroy();
      await db.destroy();
    }
  });

  test('commits bounded batches, resumes after cancellation and keeps tagged tokens invisible to old readers', async () => {
    const name = await emptyDatabase(template);
    const db = open(name);
    const writer = open(name);
    const observer = open(name);
    try {
      expect((await migrateToLatest(db, expandedDirectory)).error).toBeUndefined();
      await sql`insert into workspace_invitations
        (id, created_at, workspace_id, created_by, token_hash, expires_at,
         access_kind, guest_email, guest_channels, guest_modules)
        select ('019a0000-0000-7000-8000-' || lpad(i::text, 12, '0'))::uuid,
          now(), ${workspace}, ${owner},
          case when i = 1 then ${digest(guestToken)} else md5(i::text) || md5('guest-' || i::text) end,
          now() + interval '1 hour', 'guest', 'supplier-' || i::text || '@example.test',
          array[${channel}::uuid], array['chat']::text[] from generate_series(1, 2001) as i`.execute(
        db,
      );
      expect(await legacyLookup(db, guestToken)).toBe(true);
      // Install the new writer constraint before holding a row: its brief DDL lock is separate from backfill.
      await applyBefore(db, ENCODING, 'DO $$ DECLARE changed');
      const held = await holdWrite(
        writer,
        async (tx) =>
          await sql`select id from workspace_invitations
          where id = '019a0000-0000-7000-8000-000000001001' for update`.execute(tx),
      );
      const migrationPid = await pidOf(db);
      const migrating = migrateToLatest(db, latestDirectory);
      try {
        expect(await blockedBy(observer, migrationPid, held.pid)).toBe(true);
        const progress = await sql<{ n: number }>`select count(*)::int as n
          from workspace_invitations where access_kind = 'guest' and token_hash like 'guest:%'`.execute(
          observer,
        );
        expect(progress.rows[0]?.n).toBe(1000);
        expect(
          (
            await sql<{
              canceled: boolean;
            }>`select pg_cancel_backend(${migrationPid}) as canceled`.execute(observer)
          ).rows[0]?.canceled,
        ).toBe(true);
        expect(errorCode((await migrating).error)).toBe('57014');
      } finally {
        held.release();
        await held.completed;
        await migrating;
      }
      const recorded = await sql<{ n: number }>`select count(*)::int as n from kysely_migration
        where name = '0100_guest_invitation_token_encoding'`.execute(db);
      expect(recorded.rows[0]?.n).toBe(0);
      expect((await migrateToLatest(db, latestDirectory)).error).toBeUndefined();
      const rows = await sql<{ n: number; tagged: number }>`select count(*)::int as n,
        count(*) filter (where token_hash ~ '^guest:[0-9a-f]{64}$')::int as tagged
        from workspace_invitations where access_kind = 'guest'`.execute(db);
      expect(rows.rows).toEqual([{ n: 2001, tagged: 2001 }]);
      expect(await legacyLookup(db, guestToken)).toBe(false);
      expect(await legacyLookup(db, `guest:${guestToken}`)).toBe(false);
      expect(await legacyLookup(db, digest(guestToken))).toBe(false);
      expect(await legacyLookup(db, `guest:${digest(guestToken)}`)).toBe(false);
      expect(await legacyLookup(db, memberToken)).toBe(true);
      const first = await sql<{
        guest_email: string;
        guest_channels: string[];
        token_hash: string;
      }>`
        select guest_email, guest_channels, token_hash from workspace_invitations
        where id = '019a0000-0000-7000-8000-000000000001'`.execute(db);
      expect(first.rows).toEqual([
        {
          guest_email: 'supplier-1@example.test',
          guest_channels: [channel],
          token_hash: `guest:${digest(guestToken)}`,
        },
      ]);
      for (const [kind, token] of [
        ['guest', digest('rejected-guest-fixture')],
        ['member', `guest:${digest('rejected-member-fixture')}`],
      ]) {
        const refusal = await sql`insert into workspace_invitations
          (id, created_at, workspace_id, created_by, token_hash, expires_at,
           access_kind, guest_email, guest_channels, guest_modules)
          values (${Bun.randomUUIDv7()}, now(), ${workspace}, ${owner}, ${token},
            now() + interval '1 hour', ${kind},
            case when ${kind} = 'guest' then 'refused@example.test' else null end,
            case when ${kind} = 'guest' then array[${channel}::uuid] else null end,
            case when ${kind} = 'guest' then array['chat']::text[] else null end)`
          .execute(db)
          .then(() => undefined, errorCode);
        expect(refusal).toBe('23514');
      }
      const repeated = await migrateToLatest(db, latestDirectory);
      expect(repeated.error).toBeUndefined();
      expect(repeated.results).toEqual([]);
    } finally {
      await observer.destroy();
      await writer.destroy();
      await db.destroy();
    }
  });

  for (const [file, index] of [
    [EXPANSION, 'idx_workspace_members_guest_expiry'],
    [DIRECTORY, 'idx_workspace_guest_directory'],
  ] as const) {
    test(`${file}: writes continue during a real build wait and an invalid index resumes`, async () => {
      const name = await emptyDatabase(template);
      const db = open(name);
      const writer = open(name);
      const builder = open(name);
      try {
        if (file === DIRECTORY)
          expect((await migrateToLatest(db, copiedBelow(DIRECTORY))).error).toBeUndefined();
        const statement = await applyBefore(db, file, 'CREATE INDEX');
        const held = await holdWrite(
          writer,
          async (tx) =>
            await sql`update workspace_members set joined_at = joined_at
            where workspace_id = ${workspace} and user_id = ${owner}`.execute(tx),
        );
        const builderPid = await pidOf(builder);
        const building = sql
          .raw(statement)
          .execute(builder)
          .then(() => undefined, errorCode);
        try {
          expect(await blockedBy(db, builderPid, held.pid)).toBe(true);
          await db.transaction().execute(async (tx) => {
            await sql`set local statement_timeout = '1s'`.execute(tx);
            const written = await sql<{
              user_id: string;
            }>`update workspace_members set joined_at = joined_at
              where workspace_id = ${workspace} and user_id = ${colleague} returning user_id`.execute(
              tx,
            );
            expect(written.rows).toEqual([{ user_id: colleague }]);
          });
          expect(
            (
              await sql<{
                canceled: boolean;
              }>`select pg_cancel_backend(${builderPid}) as canceled`.execute(db)
            ).rows[0]?.canceled,
          ).toBe(true);
          expect(await building).toBe('57014');
        } finally {
          held.release();
          await held.completed;
          await building;
        }
        const interrupted = await sql<{ valid: boolean }>`select indisvalid as valid
          from pg_index where indexrelid = ${index}::regclass`.execute(db);
        expect(interrupted.rows).toEqual([{ valid: false }]);
        expect((await migrateToLatest(db, latestDirectory)).error).toBeUndefined();
        const resumed = await sql<{ valid: boolean }>`select indisvalid as valid
          from pg_index where indexrelid = ${index}::regclass`.execute(db);
        expect(resumed.rows).toEqual([{ valid: true }]);
      } finally {
        await builder.destroy();
        await writer.destroy();
        await db.destroy();
      }
    });
  }
});
