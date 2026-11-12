/**
 * `bun run entitlements:apply` (D-292) as a process against a database of the test's own: an edition file is applied to the workspaces
 * it lists in one transaction, a dry run changes nothing, running it again changes nothing, and a file that cannot be applied, or a
 * workspace that is not there, applies none of it.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { aUniqueSlug } from '../testing/users';

const SCRIPT = `${import.meta.dir}/entitlements-apply.ts`;
const clones: (() => Promise<void>)[] = [];
// One case invokes several processes; each child is independently bounded, without counting clone setup.
const CLI_PROCESS_MS = 5_000;
const CLI_CASE_MS = 30_000;
afterAll(async () => {
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const run = (url: string, args: readonly string[], env: Record<string, string> = {}): Ran => {
  const rest = { ...process.env };
  delete rest['DATABASE_URL'];
  delete rest['REDIS_URL'];
  const done = Bun.spawnSync(['bun', '--no-env-file', 'run', SCRIPT, ...args], {
    timeout: CLI_PROCESS_MS,
    env: {
      ...rest,
      APP_URL: 'https://purlay.test',
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      DATABASE_URL: url,
      ...env,
    },
  });
  if (done.exitedDueToTimeout)
    throw new Error(`entitlements:apply exceeded its ${String(CLI_PROCESS_MS)}ms process deadline`);
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

const aFile = (content: unknown): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'editions-')), 'editions.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
};

const aServer = async (): Promise<{
  url: string;
  slug: string;
  db: ClonedDatabase['db'];
  rows: () => Promise<string[]>;
}> => {
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  const slug = aUniqueSlug('edition');
  await cloned.db.insertInto('workspaces').values({ name: 'Edition', slug }).execute();
  return {
    url: cloned.connectionString,
    slug,
    db: cloned.db,
    rows: async () =>
      (
        await cloned.db
          .selectFrom('workspace_modules')
          .select(['module', 'state', 'source'])
          .where('source', 'like', 'file:%')
          .orderBy('module')
          .execute()
      ).map((row) => `${row.module}:${row.state}:${row.source}`),
  };
};

// Setup has the same queue allowance as every other clone-owning hook (D-228, #1420).
let server: Awaited<ReturnType<typeof aServer>>;
beforeEach(async () => {
  server = await aServer();
}, CLONE_HOOK_MS);

describe('integration: bun run entitlements:apply', () => {
  test(
    'applies an edition, says what changed by module, and again changes nothing',
    async () => {
      const path = aFile({
        editions: { free: ['chat'], team: ['chat', 'issues'] },
        workspaces: { [server.slug]: { edition: 'free' } },
      });
      const first = run(server.url, ['--file', path]);
      expect(first.code).toBe(0);
      expect(first.err).toBe('');
      expect(first.out).toEndWith('changed 1 of 1 grants\n  issues off: 1\n');
      // The trail's line is written, by id (D-222), with nobody as the actor.
      expect(first.out).toContain('"action":"server.module_withdrawn"');
      expect(await server.rows()).toEqual(['issues:off:file:editions.json']);
      const again = run(server.url, ['--file', path]);
      expect(again.out).toBe('changed 0 of 1 grants\n');
      // Another edition for the same workspace is a change, and the trail has all of them.
      const upgraded = aFile({
        editions: { team: ['chat', 'issues'] },
        workspaces: { [server.slug]: { edition: 'team' } },
      });
      expect(run(server.url, ['--file', upgraded]).out).toEndWith(
        'changed 1 of 1 grants\n  issues on: 1\n',
      );
      expect(await server.rows()).toEqual(['issues:on:file:editions.json']);
    },
    CLI_CASE_MS,
  );

  test(
    'a dry run says what would change and changes nothing',
    async () => {
      const path = aFile({
        editions: { free: ['chat'] },
        workspaces: { [server.slug]: { edition: 'free' } },
      });
      const dry = run(server.url, ['--file', path, '--dry-run']);
      // Each address in the file is said with the workspace it found, for the operator to read against their customers.
      expect(dry.out).toMatch(
        new RegExp(
          `^workspace ${server.slug} = [0-9a-f-]{36}\\nwould change 1 of 1 grants\\n  issues off: 1\\n$`,
        ),
      );
      expect(await server.rows()).toEqual([]);
    },
    CLI_CASE_MS,
  );

  test(
    'on a clustered server a file that takes grants away needs the operator to say every node reads them, and one that only grants does not',
    async () => {
      const clustered = { REDIS_URL: 'redis://127.0.0.1:1' };
      const takes = aFile({
        editions: { free: ['chat'] },
        workspaces: { [server.slug]: { edition: 'free' } },
      });
      const refused = run(server.url, ['--file', takes], clustered);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('--cluster-ready');
      expect(await server.rows()).toEqual([]);
      // Granting needs no word; saying it lets the withdrawal through.
      const gives = aFile({
        editions: { team: ['chat', 'issues'] },
        workspaces: { [server.slug]: { edition: 'team' } },
      });
      expect(run(server.url, ['--file', gives], clustered).code).toBe(0);
      expect(run(server.url, ['--file', takes, '--cluster-ready'], clustered).code).toBe(0);
      expect(await server.rows()).toEqual(['issues:off:file:editions.json']);
    },
    CLI_CASE_MS,
  );

  test(
    'a file or a workspace it cannot use applies none of it, and exits 2 saying why',
    async () => {
      const bad = run(server.url, [
        '--file',
        aFile({
          editions: { free: ['chat', 'mail'] },
          workspaces: {
            [server.slug]: { edition: 'free' },
            'no-such-workspace': { edition: 'free' },
          },
        }),
      ]);
      expect(bad.code).toBe(2);
      expect(bad.err).toContain('edition "free" lists "mail", which this build does not carry');
      expect(bad.err).toContain('there is no workspace "no-such-workspace"');
      expect(await server.rows()).toEqual([]);
      expect(run(server.url, ['--file', aFile('{')]).code).toBe(2);
      expect(run(server.url, []).code).toBe(2);
      expect(run(server.url, ['--file', join(tmpdir(), 'does-not-exist.json')]).code).not.toBe(0);
    },
    CLI_CASE_MS,
  );

  test(
    'a workspace written twice in one file is refused with nothing applied, since the parser would keep the last and say nothing',
    async () => {
      const twice = `{"editions":{"free":["chat"],"team":["chat","issues"]},"workspaces":{"${server.slug}":{"edition":"free"},"${server.slug}":{"edition":"team"}}}`;
      const refused = run(server.url, ['--file', aFile(twice)]);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain(`"${server.slug}" is written more than once`);
      expect(await server.rows()).toEqual([]);
    },
    CLI_CASE_MS,
  );

  test(
    '--cluster-ready is warned of and recorded with the grants it let through; without it nothing is recorded',
    async () => {
      const clustered = { REDIS_URL: 'redis://127.0.0.1:1' };
      const takes = aFile({
        editions: { free: ['chat'] },
        workspaces: { [server.slug]: { edition: 'free' } },
      });
      const said = run(server.url, ['--file', takes, '--cluster-ready'], clustered);
      expect(said.code).toBe(0);
      expect(said.out).toContain('"level":"warn"');
      expect(said.out).toContain(
        '--cluster-ready is the operator’s word that every node reads workspace grants',
      );
      const entry = await server.db
        .selectFrom('server_audit_log')
        .select(['module_state_before', 'cluster_ready_asserted'])
        .where('action', '=', 'server.module_withdrawn')
        .executeTakeFirstOrThrow();
      expect(entry).toEqual({ module_state_before: null, cluster_ready_asserted: true });
    },
    CLI_CASE_MS,
  );
});
