/**
 * Two API processes of one cluster, each the real entry point started as an operating system starts it, on one database and one
 * Redis (D-289, D-292): a restriction of a workspace's modules is refused with `409 PEERS_BEHIND` while a live node does not read
 * grants, goes through once every node does, and is what both processes serve on their next request.
 *
 * `ingress/http/entitlement-cluster.redis.integration.test.ts` holds the same rules over two applications of one process; this
 * holds that the process announces itself, renews and leaves as the rules assume. The older node is the same entry point with a
 * preload that does not say it reads grants until a file exists (`testing/node-without-grants-preload.ts`).
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
import { peersBehind } from './realtime/entitlement-peers';
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

/** A process boots in a couple of seconds on an idle machine; the budget is for a runner busy with other jobs' tests. */
const BOOT_MS = 30_000;
/**
 * A node is in the cluster's records once its Redis connection is up, a second or so after it listens. Under a renewal
 * (`NODE_TTL_MS / 3`, ten seconds): a node that waited for its first renewal would not be seen by a restriction for that long.
 */
const RECORD_MS = 8_000;
/** The older node's drain has ten seconds (`index.ts`); a node past that did not leave. */
const LEAVE_MS = 15_000;

let cloned: ClonedDatabase;
let directory: string;
const started: ClusterNode[] = [];
const links: RedisLink[] = [];

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  directory = await mkdtemp(join(tmpdir(), 'purlay-grants-gate-'));
}, CLONE_HOOK_MS);

afterEach(async () => {
  await killClusterNodes(started.splice(0));
  for (const link of links.splice(0)) {
    await link.send('DEL', [link.names.moduleSet, link.names.entitlementNodes]);
    link.close();
  }
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
  await cloned.drop();
}, DROP_HOOK_MS);

interface Cluster {
  readonly newer: ClusterNode;
  readonly older: ClusterNode;
  /** Makes the older node say that it reads grants, as the node of this release does from the start. */
  readonly olderLearnsGrants: () => Promise<void>;
  readonly peersBehind: () => Promise<number>;
  readonly operator: SignedInUser;
}

/** A node of this release and one of the release before, both ready and both in the cluster's record, and a server administrator. */
const aCluster = async (): Promise<Cluster> => {
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
      env: { GRANTS_GATE: gate },
    });
    started.push(made);
    return made;
  };
  const [newer, older] = [node([]), node([preloadFile('node-without-grants-preload.ts')])];
  await Promise.all([untilReady(newer, BOOT_MS), untilReady(older, BOOT_MS)]);
  const behind = async (): Promise<number> => await peersBehind(link);
  // Both are in the module-set record and only the newer is in the grants one: the positive condition, not a time passed.
  await eventually(
    'the cluster has one node behind',
    async () => (await behind()) === 1,
    RECORD_MS,
  );
  const operator = await aSignedInUser(cloned.db, systemClock, 'process-op');
  await cloned.db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', operator.userId)
    .execute();
  return {
    newer,
    older,
    olderLearnsGrants: async (): Promise<void> => {
      await writeFile(gate, 'open');
      await eventually('no node is behind', async () => (await behind()) === 0, RECORD_MS);
    },
    peersBehind: behind,
    operator,
  };
};

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
const modulesOf = (answer: Answer, workspaceId: string): unknown =>
  (
    answer.body as { memberships: { workspace: { id: string }; modules?: string[] }[] }
  ).memberships.find((membership) => membership.workspace.id === workspaceId)?.modules;

const modulePath = (workspaceId: string): string => `/api/server/workspaces/${workspaceId}/modules`;

const aWorkspace = async (node: ClusterNode, who: SignedInUser): Promise<string> => {
  const slug = aUniqueSlug('proc');
  const answer = await call(node, 'POST', '/api/workspaces', who, { name: slug, slug });
  expect(answer.status).toBe(201);
  return (answer.body as { id: string }).id;
};

const rowsOf = async (workspaceId: string): Promise<unknown[]> =>
  await cloned.db
    .selectFrom('workspace_modules')
    .select(['module', 'state'])
    .where('workspace_id', '=', workspaceId)
    .execute();

describe('integration: two API processes on one database and one Redis', () => {
  test('a restriction waits for the process that does not read grants, then both processes turn the workspace away at once', async () => {
    const { newer, older, olderLearnsGrants, operator } = await aCluster();
    const [restricted, untouched] = [
      await aWorkspace(newer, operator),
      await aWorkspace(newer, operator),
    ];
    const issuesOn = async (node: ClusterNode, workspaceId: string): Promise<number> =>
      (await call(node, 'GET', `/api/workspaces/${workspaceId}/issues`, operator)).status;

    // Refused by either process, for the cluster's reason and not the process's, and nothing is written.
    for (const node of [newer, older]) {
      const refused = await call(node, 'POST', modulePath(restricted), operator, {
        module: 'issues',
        state: 'off',
      });
      expect(refused.status).toBe(409);
      expect(errorCodeOf(refused)).toBe('PEERS_BEHIND');
    }
    expect(await rowsOf(restricted)).toEqual([]);
    expect(await issuesOn(older, restricted)).toBe(200);

    // A grant is never refused for a process that is behind, and the other process serves it at once.
    expect(
      (
        await call(newer, 'POST', modulePath(untouched), operator, {
          module: 'issues',
          state: 'on',
        })
      ).status,
    ).toBe(204);
    expect(await rowsOf(untouched)).toEqual([{ module: 'issues', state: 'on' }]);

    // The older process now says it reads grants: the cluster is ready, and the restriction goes through.
    await olderLearnsGrants();
    expect(
      (
        await call(newer, 'POST', modulePath(restricted), operator, {
          module: 'issues',
          state: 'off',
        })
      ).status,
    ).toBe(204);

    // Both processes turn the workspace away on their next request, with nothing to invalidate; the other keeps its module.
    for (const node of [newer, older]) {
      expect(await issuesOn(node, restricted)).toBe(404);
      expect(await issuesOn(node, untouched)).toBe(200);
      const me = await call(node, 'GET', '/api/me', operator);
      expect(me.status).toBe(200);
      expect(modulesOf(me, restricted)).toEqual(['chat']);
      expect(modulesOf(me, untouched)).toEqual(['chat', 'issues']);
    }

    // A change made through the older process is just as visible to the newer.
    expect(
      (
        await call(older, 'POST', modulePath(restricted), operator, {
          module: 'issues',
          state: 'inherit',
        })
      ).status,
    ).toBe(204);
    expect(await issuesOn(newer, restricted)).toBe(200);
    const me = await call(newer, 'GET', '/api/me', operator);
    expect(modulesOf(me, restricted)).toEqual(['chat', 'issues']);
  }, 120_000);

  test('a process that leaves is a process the cluster no longer waits for', async () => {
    const { newer, older, operator, peersBehind: behind } = await aCluster();
    const workspaceId = await aWorkspace(newer, operator);
    const restrict = async (): Promise<Answer> =>
      await call(newer, 'POST', modulePath(workspaceId), operator, {
        module: 'issues',
        state: 'off',
      });

    expect((await restrict()).status).toBe(409);

    older.process.kill('SIGTERM');
    const code = await Promise.race([
      older.process.exited,
      Bun.sleep(LEAVE_MS).then(() => 'still running'),
    ]);
    expect(code).toBe(0);
    // Its entry went with it, not thirty seconds later when it would have lapsed.
    expect(await behind()).toBe(0);
    expect((await restrict()).status).toBe(204);
    expect(await rowsOf(workspaceId)).toEqual([{ module: 'issues', state: 'off' }]);
    expect(
      (await call(newer, 'GET', `/api/workspaces/${workspaceId}/issues`, operator)).status,
    ).toBe(404);
  }, 120_000);
});
