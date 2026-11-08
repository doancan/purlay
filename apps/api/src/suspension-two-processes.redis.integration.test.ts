/**
 * Two API processes of one cluster, each the real entry point, on one database and one Redis (D-296): a stop is refused with
 * `409 PEERS_BEHIND` while a live process does not read the stopped modules, goes through once every one does, and is what both
 * processes serve on their next request after the TTL. A resume is never refused for it.
 *
 * The older process is the same entry point with a preload that does not say it reads the stops until a file exists
 * (`testing/node-without-suspension-preload.ts`); `entitlement-two-processes.redis.integration.test.ts` holds the same rule for grants.
 *
 * @needs-modules chat, issues
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { systemClock } from './platform/clock';
import { createLogger } from './platform/logging';
import { bunRedisClient, connectRedis, type RedisLink } from './platform/redis';
import { SUSPENSION_TTL_MS } from './platform/suspended-modules';
import { suspensionPeersBehind } from './realtime/entitlement-peers';
import {
  aClusterNamespace,
  eventually,
  killClusterNodes,
  preloadFile,
  startClusterNode,
  untilReady,
  type ClusterNode,
} from './testing/cluster-node';
import { redisUrlForTests } from './testing/redis';
import { aSignedInUser, type SignedInUser } from './testing/signed-in';
import { aUniqueSlug } from './testing/users';

const BOOT_MS = 30_000;
/** A process is in the cluster's records once its Redis connection is up, a second or so after it listens. */
const RECORD_MS = 8_000;
const BELIEVED_MS = SUSPENSION_TTL_MS + 2_500;

let cloned: ClonedDatabase;
let directory: string;
const started: ClusterNode[] = [];
const links: RedisLink[] = [];

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  directory = await mkdtemp(join(tmpdir(), 'purlay-suspension-gate-'));
}, CLONE_HOOK_MS);

afterEach(async () => {
  await killClusterNodes(started.splice(0));
  for (const link of links.splice(0)) {
    await link.send('DEL', [link.names.moduleSet, link.names.suspensionNodes]);
    link.close();
  }
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await cloned.drop();
}, DROP_HOOK_MS);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const call = async (
  node: ClusterNode,
  method: string,
  path: string,
  who: SignedInUser,
  body?: unknown,
): Promise<Answer> => {
  const response = await fetch(`${node.origin}${path}`, {
    method,
    headers: {
      cookie: who.cookie,
      origin: node.origin,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
};

const errorCodeOf = (answer: Answer): unknown =>
  (answer.body as { error?: { code?: unknown } }).error?.code;

describe('integration: two API processes on one database and one Redis', () => {
  test('a stop waits for the process that does not read the stops, then both processes turn the module away, and a resume never waits', async () => {
    const redisPrefix = aClusterNamespace();
    const redisUrl = redisUrlForTests();
    const link = connectRedis({
      create: () => bunRedisClient(redisUrl),
      log: createLogger({ level: 'silent' }),
      namespace: redisPrefix,
    });
    links.push(link);
    const gate = join(directory, `${redisPrefix}.open`);
    const node = (preloads: readonly string[]): ClusterNode => {
      const made = startClusterNode({
        databaseUrl: cloned.connectionString,
        redisUrl,
        redisPrefix,
        preloads,
        env: { SUSPENSION_GATE: gate },
      });
      started.push(made);
      return made;
    };
    const [newer, older] = [node([]), node([preloadFile('node-without-suspension-preload.ts')])];
    await Promise.all([untilReady(newer, BOOT_MS), untilReady(older, BOOT_MS)]);
    await eventually(
      'the cluster has one node behind',
      async () => (await suspensionPeersBehind(link)) === 1,
      RECORD_MS,
    );
    const operator = await aSignedInUser(cloned.db, systemClock, 'process-op');
    await cloned.db
      .updateTable('users')
      .set({ is_server_admin: true })
      .where('id', '=', operator.userId)
      .execute();
    const slug = aUniqueSlug('stop');
    const made = await call(newer, 'POST', '/api/workspaces', operator, { name: slug, slug });
    const workspaceId = (made.body as { id: string }).id;
    const issues = async (who: ClusterNode): Promise<number> =>
      (await call(who, 'GET', `/api/workspaces/${workspaceId}/issues`, operator)).status;
    const stop = async (who: ClusterNode): Promise<Answer> =>
      await call(who, 'POST', '/api/server/modules/issues/suspension', operator, {
        state: 'suspended',
        reason: 'misbehaving in production',
      });

    // Refused by either process, for the cluster's reason, and nothing is written; the older one goes on serving.
    for (const who of [newer, older]) {
      const refused = await stop(who);
      expect(refused.status).toBe(409);
      expect(errorCodeOf(refused)).toBe('PEERS_BEHIND');
    }
    expect(
      await cloned.db
        .selectFrom('suspended_modules')
        .select('module')
        .where('module', 'in', ['issues', 'chat'])
        .execute(),
    ).toEqual([]);
    expect(await issues(older)).toBe(200);

    // The older process now says it reads the stops: the cluster is ready, and the stop goes through.
    await writeFile(gate, 'open');
    await eventually(
      'no node is behind',
      async () => (await suspensionPeersBehind(link)) === 0,
      RECORD_MS,
    );
    expect((await stop(newer)).status).toBe(200);
    for (const who of [newer, older]) {
      await eventually(
        'a process turns issues away',
        async () => (await issues(who)) === 404,
        BELIEVED_MS,
      );
    }

    // A resume is a lifting: it goes through whatever the cluster reads, and both processes serve again.
    expect(
      (
        await call(older, 'POST', '/api/server/modules/issues/suspension', operator, {
          state: 'running',
        })
      ).status,
    ).toBe(200);
    for (const who of [newer, older]) {
      await eventually(
        'a process serves issues',
        async () => (await issues(who)) === 200,
        BELIEVED_MS,
      );
    }
  }, 120_000);
});
