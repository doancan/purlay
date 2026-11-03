/**
 * Two real API processes of one cluster that run different `MODULES` (D-250): each says the other's set in its
 * log, neither stops or turns unready, and when the second leaves the first says the nodes agree again — which
 * is a rolling deploy of a new set, node by node. They share one database (a fresh one) and one Redis.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CLONE_HOOK_MS, createDatabase, DROP_HOOK_MS, sql } from '@purlay/db';
import { bunRedisClient, connectRedis } from '../platform/redis';
import { createLogger } from '../platform/logging';
import { redisUrlForTests } from '../testing/redis';
import { MODULE_SET_KEY, NODE_TTL_MS } from './module-set';

const source = process.env['DATABASE_URL'];
if (source === undefined || source === '') {
  throw new Error('DATABASE_URL is not set, so these tests would silently prove nothing.');
}
const urlFor = (name: string): string => {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
};

const NAME = `${new URL(source).pathname.slice(1)}_mset_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
const admin = createDatabase({ connectionString: urlFor('postgres'), poolSize: 1 });
const redisUrl = redisUrlForTests();
const redis = connectRedis({
  create: () => bunRedisClient(redisUrl),
  log: createLogger({ level: 'silent' }),
});

interface Node {
  readonly process: Bun.Subprocess<'ignore', 'pipe', 'ignore'>;
  readonly port: number;
  /** Everything the node has written to its standard output so far. */
  readonly said: () => string;
}

const freePort = (): number => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port ?? 0;
  void probe.stop(true);
  return port;
};

const aNode = (modules: string, key: string): Node => {
  const port = freePort();
  const process_ = Bun.spawn(['bun', '--no-env-file', join(import.meta.dir, '../index.ts')], {
    stdout: 'pipe',
    stderr: 'ignore',
    env: {
      PATH: process.env['PATH'] ?? '',
      NODE_ENV: 'development',
      PORT: String(port),
      APP_URL: `http://localhost:${String(port)}`,
      DATABASE_URL: urlFor(NAME),
      REDIS_URL: redisUrl,
      GITHUB_CLIENT_ID: 'id',
      GITHUB_CLIENT_SECRET: 'secret',
      ENCRYPTION_KEY: key,
      MIGRATE_ON_START: 'true',
      MODULES: modules,
    },
  });
  let output = '';
  void (async (): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of process_.stdout) output += decoder.decode(chunk);
  })();
  return { process: process_, port, said: () => output };
};

const readyStatus = async (node: Node): Promise<number> =>
  await fetch(`http://127.0.0.1:${String(node.port)}/health/ready`).then(
    (response) => response.status,
    () => 0,
  );

const eventually = async (
  what: string,
  holds: () => boolean | Promise<boolean>,
  seconds = 40,
): Promise<void> => {
  for (let attempt = 0; attempt < seconds * 10; attempt += 1) {
    if (await holds()) return;
    await Bun.sleep(100);
  }
  throw new Error(`never: ${what}`);
};

const MISMATCH = 'do not run the same modules';
const AGREE = 'run the same modules again';

const nodes: Node[] = [];

beforeAll(async () => {
  await sql`create database ${sql.id(NAME)}`.execute(admin);
  await redis.send('DEL', [MODULE_SET_KEY]);
}, CLONE_HOOK_MS);

afterAll(async () => {
  for (const node of nodes) node.process.kill();
  await Promise.all(nodes.map(async (node) => await node.process.exited));
  await redis.send('DEL', [MODULE_SET_KEY]).catch(() => undefined);
  redis.close();
  await sql`drop database if exists ${sql.id(NAME)} with (force)`.execute(admin);
  await admin.destroy();
}, DROP_HOOK_MS);

describe('integration: a cluster whose nodes run different module sets', () => {
  test('each node says so and serves on, and says when the nodes agree again', async () => {
    const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
    const first = aNode('chat', key);
    nodes.push(first);
    await eventually('the first node is ready', async () => (await readyStatus(first)) === 200);
    expect(first.said()).not.toContain(MISMATCH);

    // A new set rolling out: a node of the core alone joins a node that runs chat.
    const second = aNode('none', key);
    nodes.push(second);
    await eventually('the second node is ready', async () => (await readyStatus(second)) === 200);
    await eventually('the second node names the mismatch', () => second.said().includes(MISMATCH));
    // The first finds out on its next renewal.
    await eventually('the first node names the mismatch', () => first.said().includes(MISMATCH));

    // Neither stopped and neither is turned away from traffic.
    expect([first.process.exitCode, second.process.exitCode]).toEqual([null, null]);
    expect([await readyStatus(first), await readyStatus(second)]).toEqual([200, 200]);
    expect(first.said()).toContain('"otherNodes":["none"]');
    expect(second.said()).toContain('"otherNodes":["chat"]');

    // The second node leaves cleanly: its entry goes with it, not thirty seconds later.
    second.process.kill('SIGTERM');
    await second.process.exited;
    // Within one renewal, well short of the lapse a node that was killed would leave behind.
    expect(NODE_TTL_MS).toBeGreaterThan(20_000);
    await eventually('the first node says the nodes agree', () => first.said().includes(AGREE), 20);
  }, 120_000);
});
