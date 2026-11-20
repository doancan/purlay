/**
 * `bun run outbox:requeue` and `outbox:discard` (D-288 §12) as processes against a database of the test's own: dead deliveries are
 * sent back or given up on with the operator's reason, each on the server's trail; a second run is the same and records nothing;
 * a delivery that is over and an id nobody has are said and exit 1; and every argument the console would refuse exits 2 with
 * nothing written.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, DROP_HOOK_MS } from '@purlay/db';
import { messageId } from '@purlay/types';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../platform/config';
import { anOutboxRow, aWorkspaceRow } from '../testing/facts';

const SCRIPT = `${import.meta.dir}/outbox.ts`;
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

const run = (url: string, args: readonly string[]): Ran => {
  const rest = { ...process.env };
  delete rest['DATABASE_URL'];
  delete rest['REDIS_URL'];
  const done = Bun.spawnSync(['bun', '--no-env-file', 'run', SCRIPT, ...args], {
    env: {
      ...rest,
      APP_URL: 'https://purlay.test',
      ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
      DATABASE_URL: url,
    },
  });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

/** A day ago: the facts died a while before the operator looks. */
const DIED = new Date(Date.now() - 86_400_000);

const aServer = async (): Promise<{
  url: string;
  dead: (count: number) => Promise<string[]>;
  over: () => Promise<string>;
  states: (ids: readonly string[]) => Promise<string[]>;
  trail: () => Promise<string[]>;
}> => {
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  const workspaceId = await aWorkspaceRow(cloned.db);
  return {
    url: cloned.connectionString,
    dead: async (count) =>
      await Promise.all(
        Array.from(
          { length: count },
          async () =>
            (
              await anOutboxRow(cloned.db, workspaceId, {
                state: 'dead',
                at: DIED,
                attempts: 8,
                lastError: 'timeout',
              })
            ).id,
        ),
      ),
    over: async () =>
      (await anOutboxRow(cloned.db, workspaceId, { state: 'delivered', at: DIED })).id,
    states: async (ids) =>
      (
        await cloned.db
          .selectFrom('outbox')
          .select(['id', 'state', 'attempts'])
          .where('id', 'in', ids)
          .execute()
      )
        .sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
        .map((row) => `${row.state}:${String(row.attempts)}`),
    trail: async () =>
      (
        await cloned.db
          .selectFrom('server_audit_log')
          .select(['action', 'target_module', 'note', 'actor_user_id', 'target_fact_id'])
          .where('action', 'like', 'server.fact_%')
          .orderBy('id')
          .execute()
      ).map(
        (row) =>
          `${row.action} ${String(row.target_module)} ${String(row.note)} ${String(row.actor_user_id)}`,
      ),
  };
};

describe('integration: bun run outbox:requeue and outbox:discard', () => {
  test('requeue dead deliveries with the reason, on the trail, and the same again changes nothing', async () => {
    const server = await aServer();
    const ids = await server.dead(2);
    const first = run(server.url, ['requeue', ...ids, '--reason', 'the wiki is back, şimdi dene']);
    expect(first.code).toBe(0);
    expect(first.out).toContain(`${ids[0] ?? ''} changed`);
    expect(first.out).toContain(`${ids[1] ?? ''} changed`);
    expect(first.out).toContain('2 requeued');
    expect(await server.states(ids)).toEqual(['pending:0', 'pending:0']);
    expect(await server.trail()).toEqual([
      'server.fact_requeued wiki the wiki is back, şimdi dene null',
      'server.fact_requeued wiki the wiki is back, şimdi dene null',
    ]);

    const again = run(server.url, ['requeue', ...ids, '--reason', 'other words']);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`${ids[0] ?? ''} unchanged`);
    expect(again.out).toContain('nothing changed');
    expect(await server.trail()).toHaveLength(2);
  }, 60_000);

  test('discard gives up on a dead delivery, once; one that is over and one nobody has exit 1, the rest changed', async () => {
    const server = await aServer();
    const [dead = ''] = await server.dead(1);
    const over = await server.over();
    const nobody = messageId(new Date());
    const mixed = run(server.url, ['discard', dead, over, nobody, '--reason', 'a test fact']);
    expect(mixed.code).toBe(1);
    expect(mixed.out).toContain(`${dead} changed`);
    expect(mixed.out).toContain(`${over} refused`);
    expect(mixed.out).toContain(`${nobody} not_found`);
    expect(mixed.err).toContain('not found, or its delivery is over');
    expect(await server.states([dead, over])).toEqual(['discarded:8', 'delivered:0']);
    expect(await server.trail()).toEqual(['server.fact_discarded wiki a test fact null']);

    const again = run(server.url, ['discard', dead, '--reason', 'a test fact']);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`${dead} unchanged`);
    expect(await server.trail()).toHaveLength(1);
  }, 60_000);

  test('refuse, with exit 2 and nothing written, every argument the console would refuse', async () => {
    const server = await aServer();
    const [id = ''] = await server.dead(1);
    const refusals: readonly (readonly [readonly string[], string])[] = [
      [[], 'usage:'],
      [['requeue', '--reason', 'why'], 'usage:'],
      [['purge', id, '--reason', 'why'], 'usage:'],
      [['requeue', id], '--reason'],
      [['requeue', id, '--reason'], '--reason'],
      [['requeue', id, '--reason', '   '], 'not blank'],
      [['requeue', id, '--reason', 'x'.repeat(201)], '1 to 200 characters'],
      [['requeue', 'not-an-id', '--reason', 'why'], 'not a delivery id: not-an-id'],
      [['requeue', id, id, '--reason', 'why'], 'written twice'],
      [
        ['requeue', ...Array.from({ length: 51 }, () => messageId(new Date())), '--reason', 'why'],
        'at most 50 ids',
      ],
    ];
    for (const [args, says] of refusals) {
      const refused = run(server.url, args);
      expect({ args, code: refused.code }).toEqual({ args, code: 2 });
      expect(refused.err).toContain(says);
    }
    expect(await server.states([id])).toEqual(['dead:8']);
    expect(await server.trail()).toEqual([]);
  }, 120_000);
});
