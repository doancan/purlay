/**
 * `bun run module:suspend` and `module:resume` (D-296) as processes against a database of the test's own: a module is stopped with
 * the operator's reason, on the server's trail, and again is the same; chat is stopped only when meant; a clustered server asks to
 * be told that every node reads the stops; a resume never asks that; and every refusal writes nothing.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, DROP_HOOK_MS } from '@purlay/db';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';

const SCRIPT = `${import.meta.dir}/module-suspension.ts`;
const clones: (() => Promise<void>)[] = [];
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
    env: {
      ...rest,
      APP_URL: 'https://purlay.test',
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      DATABASE_URL: url,
      ...env,
    },
  });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

const aServer = async (): Promise<{
  url: string;
  stopped: () => Promise<string[]>;
  trail: () => Promise<string[]>;
}> => {
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  return {
    url: cloned.connectionString,
    stopped: async () =>
      (
        await cloned.db
          .selectFrom('suspended_modules')
          .select(['module', 'reason', 'source'])
          .where('module', 'in', ['issues', 'chat'])
          .orderBy('module')
          .execute()
      ).map((row) => `${row.module}:${row.reason}:${row.source}`),
    trail: async () =>
      (
        await cloned.db
          .selectFrom('server_audit_log')
          .select(['action', 'target_module', 'note', 'actor_user_id'])
          .where('action', 'like', 'server.module_%')
          .orderBy('id')
          .execute()
      ).map(
        (row) =>
          `${row.action} ${String(row.target_module)} ${String(row.note)} ${String(row.actor_user_id)}`,
      ),
  };
};

describe('integration: bun run module:suspend and module:resume', () => {
  test('stop a module with the operator’s reason, once however often it is run, and let it run again', async () => {
    const server = await aServer();
    const first = run(
      server.url,
      ['suspend', 'issues', '--reason', 'leaks rows between tickets'],
      {},
    );
    expect(first.code).toBe(0);
    expect(first.out).toContain('issues stopped');
    expect(first.out).toContain('nothing is restarted');
    const again = run(server.url, ['suspend', 'issues', '--reason', 'other words']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('(no change)');
    expect(await server.stopped()).toEqual(['issues:leaks rows between tickets:cli']);
    expect(await server.trail()).toEqual([
      'server.module_suspended issues leaks rows between tickets null',
    ]);

    const resumed = run(server.url, ['resume', 'issues']);
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain('issues running again');
    expect(run(server.url, ['resume', 'issues']).out).toContain('(no change)');
    expect(await server.stopped()).toEqual([]);
    expect((await server.trail()).map((line) => line.split(' ')[0])).toEqual([
      'server.module_suspended',
      'server.module_resumed',
    ]);
  }, 60_000);

  test('refuse, with exit 2 and nothing written, a module the build lacks, a stop with no reason and chat that is not meant', async () => {
    const server = await aServer();
    const unknown = run(server.url, ['suspend', 'tasks', '--reason', 'why']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Is not a module this server carries');
    const noReason = run(server.url, ['suspend', 'issues']);
    expect(noReason.code).toBe(2);
    expect(noReason.err).toContain('Is needed to stop a module');
    const chat = run(server.url, ['suspend', 'chat', '--reason', 'incident']);
    expect(chat.code).toBe(2);
    expect(chat.err).toContain('Say --force to mean it');
    expect(run(server.url, []).code).toBe(2);
    expect(run(server.url, ['suspend', 'issues', '--reason', 'why', '--unknown']).code).toBe(2);
    expect(run(server.url, ['resume', 'issues', '--force']).code).toBe(2);
    expect(await server.stopped()).toEqual([]);
    expect(await server.trail()).toEqual([]);

    expect(run(server.url, ['suspend', 'chat', '--reason', 'incident', '--force']).code).toBe(0);
    expect(await server.stopped()).toEqual(['chat:incident:cli']);
  }, 60_000);

  test('on a clustered server a stop waits for the operator to say every node reads the stops, and a resume does not', async () => {
    const server = await aServer();
    const clustered = { REDIS_URL: 'redis://127.0.0.1:1' };
    const refused = run(server.url, ['suspend', 'issues', '--reason', 'why'], clustered);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--cluster-ready');
    expect(await server.stopped()).toEqual([]);
    expect(
      run(server.url, ['suspend', 'issues', '--reason', 'why', '--cluster-ready'], clustered).code,
    ).toBe(0);
    expect(run(server.url, ['resume', 'issues'], clustered).code).toBe(0);
    expect(await server.stopped()).toEqual([]);
  }, 60_000);
});
