/**
 * Two nodes of one cluster, each its own application over its own pool, on one database and one Redis (D-289, D-292): a
 * restriction is refused while a live node does not read grants and accepted when every one does, a grant changed through one
 * node is what the other serves on its next request, and a node that leaves is a node the cluster no longer waits for.
 *
 * The nodes are announced as the process does it (`watchModuleSet`, `advertiseEntitlements`), so what the guard asks is the
 * real `peersBehind` over the real record, not a number a test hands in.
 *
 * @needs-modules chat, issues
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  createDatabase,
  type ClonedDatabase,
  type DatabasePool,
  type Executor,
} from '@purlay/db';
import { compositionFor } from '../../composition';
import { fixedClock } from '../../platform/clock';
import { createLogger } from '../../platform/logging';
import { bunRedisClient, connectRedis, type RedisLink } from '../../platform/redis';
import { advertiseEntitlements, peersBehind } from '../../realtime/entitlement-peers';
import { moduleSetOf, watchModuleSet } from '../../realtime/module-set';
import { NOW, testDependencies } from '../../testing/doubles';
import { redisUrlForTests } from '../../testing/redis';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);
const log = createLogger({ level: 'silent' });
const OPEN = compositionFor(undefined, 'open');
const MODULE_SET = moduleSetOf(['chat', 'issues']);
const NAMESPACE = `nodes-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

let cloned: ClonedDatabase;
let secondPool: DatabasePool;
let link: RedisLink;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  secondPool = createDatabase({ connectionString: cloned.connectionString, poolSize: 4 });
  link = connectRedis({
    create: () => bunRedisClient(redisUrlForTests()),
    log,
    namespace: NAMESPACE,
  });
  // Asserts the positive condition: the link is up, not merely that nothing has failed yet.
  for (let waited = 0; !link.connected(); waited += 25) {
    if (waited > 5_000) throw new Error('Redis did not connect');
    await Bun.sleep(25);
  }
}, CLONE_HOOK_MS);

afterAll(async () => {
  for (const stop of stops.splice(0)) await stop();
  await link.send('DEL', [link.names.moduleSet, link.names.entitlementNodes]);
  link.close();
  await secondPool.destroy();
  await cloned.drop();
}, DROP_HOOK_MS);

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

interface Node {
  readonly id: string;
  readonly call: (
    method: string,
    path: string,
    who: SignedInUser,
    body?: unknown,
  ) => Promise<Answer>;
  /** Says to the cluster that this node reads workspace grants, as a node of this release does. */
  readonly startReadingGrants: () => void;
  readonly stopReadingGrants: () => Promise<void>;
  /** The node leaves: gone from both records, as when its process ends. */
  readonly leave: () => Promise<void>;
}

const nodeOn = (database: Executor, id: string): Node => {
  const app = createApp(
    testDependencies({
      database,
      clock,
      composition: OPEN,
      peersBehind: async () => await peersBehind(link),
    }),
  );
  const present = watchModuleSet({ link, nodeId: id, set: MODULE_SET, log });
  let reading: { stop: () => Promise<void> } | undefined;
  const stopReadingGrants = async (): Promise<void> => {
    await reading?.stop();
    reading = undefined;
  };
  stops.push(present.stop, stopReadingGrants);
  return {
    id,
    call: async (method, path, who, body): Promise<Answer> => {
      const response = await app.handle(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: {
            cookie: who.cookie,
            origin: ORIGIN,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    },
    startReadingGrants: (): void => {
      reading = advertiseEntitlements({ link, nodeId: id, log });
    },
    stopReadingGrants,
    leave: async (): Promise<void> => {
      await stopReadingGrants();
      await present.stop();
    },
  };
};

/** Waits for the record to say it, since each node announces itself from a loop of its own. */
const untilBehind = async (count: number): Promise<void> => {
  for (let waited = 0; ; waited += 25) {
    if ((await peersBehind(link)) === count) return;
    if (waited > 5_000) throw new Error(`the cluster never had ${String(count)} node(s) behind`);
    await Bun.sleep(25);
  }
};

const idOf = (answer: Answer): string => (answer.body as { id: string }).id;
const errorCodeOf = (answer: Answer): unknown =>
  (answer.body as { error?: { code?: unknown } }).error?.code;
const modulesOf = (answer: Answer, workspaceId: string): unknown =>
  (
    answer.body as { memberships: { workspace: { id: string }; modules?: string[] }[] }
  ).memberships.find((membership) => membership.workspace.id === workspaceId)?.modules;

describe('integration: two nodes on one database and one Redis', () => {
  test('a restriction waits until every live node reads grants, a grant never does, and what one node writes the other serves', async () => {
    const newer = nodeOn(cloned.db, `newer-${crypto.randomUUID()}`);
    const older = nodeOn(secondPool, `older-${crypto.randomUUID()}`);
    const operator = await aSignedInUser(cloned.db, clock, 'cluster-op');
    await cloned.db
      .updateTable('users')
      .set({ is_server_admin: true })
      .where('id', '=', operator.userId)
      .execute();
    const made = async (): Promise<string> => {
      const slug = aUniqueSlug('cluster');
      const answer = await newer.call('POST', '/api/workspaces', operator, { name: slug, slug });
      expect(answer.status).toBe(201);
      return idOf(answer);
    };
    const [restricted, untouched] = [await made(), await made()];
    const modulePath = (workspaceId: string): string =>
      `/api/server/workspaces/${workspaceId}/modules`;
    const issuesOn = async (node: Node, workspaceId: string): Promise<number> =>
      (await node.call('GET', `/api/workspaces/${workspaceId}/issues`, operator)).status;
    const rowsOf = async (workspaceId: string): Promise<unknown[]> =>
      await cloned.db
        .selectFrom('workspace_modules')
        .select(['module', 'state'])
        .where('workspace_id', '=', workspaceId)
        .execute();

    // Only the newer node says that it reads grants: the older is a node of the cluster that serves every module to everyone.
    newer.startReadingGrants();
    await untilBehind(1);
    const refused = await newer.call('POST', modulePath(restricted), operator, {
      module: 'issues',
      state: 'off',
    });
    expect(refused.status).toBe(409);
    expect(errorCodeOf(refused)).toBe('PEERS_BEHIND');
    expect(await rowsOf(restricted)).toEqual([]);
    // The refusal is the cluster's and not the node's: the older node, asked to restrict, is refused the same.
    const refusedFromTheOlder = await older.call('POST', modulePath(restricted), operator, {
      module: 'issues',
      state: 'off',
    });
    expect(refusedFromTheOlder.status).toBe(409);
    expect(errorCodeOf(refusedFromTheOlder)).toBe('PEERS_BEHIND');
    expect(await issuesOn(older, restricted)).toBe(200);

    // A grant is never refused for a node that is behind, and the other node serves what it wrote at its next request.
    expect(
      (await newer.call('POST', modulePath(untouched), operator, { module: 'issues', state: 'on' }))
        .status,
    ).toBe(204);
    expect(await rowsOf(untouched)).toEqual([{ module: 'issues', state: 'on' }]);

    // The older node is replaced by one that reads grants: the cluster is ready, and the restriction goes through.
    older.startReadingGrants();
    await untilBehind(0);
    expect(
      (
        await newer.call('POST', modulePath(restricted), operator, {
          module: 'issues',
          state: 'off',
        })
      ).status,
    ).toBe(204);

    // Both nodes turn the workspace away at once, with no wait and nothing to invalidate; the other workspace keeps its module.
    for (const node of [newer, older]) {
      expect(await issuesOn(node, restricted)).toBe(404);
      expect(await issuesOn(node, untouched)).toBe(200);
      const me = await node.call('GET', '/api/me', operator);
      expect(modulesOf(me, restricted)).toEqual(['chat']);
      expect(modulesOf(me, untouched)).toEqual(['chat', 'issues']);
    }

    // A change made through the other node is just as visible to the first.
    expect(
      (
        await older.call('POST', modulePath(restricted), operator, {
          module: 'issues',
          state: 'inherit',
        })
      ).status,
    ).toBe(204);
    expect(await issuesOn(newer, restricted)).toBe(200);

    // A node that stops reading grants (or dies) is a node the next restriction waits for again; one that has left is not.
    await older.stopReadingGrants();
    await untilBehind(1);
    const again = await newer.call('POST', modulePath(restricted), operator, {
      module: 'issues',
      state: 'off',
    });
    expect(again.status).toBe(409);
    expect(await issuesOn(older, restricted)).toBe(200);
    await older.leave();
    await untilBehind(0);
    expect(
      (
        await newer.call('POST', modulePath(restricted), operator, {
          module: 'issues',
          state: 'off',
        })
      ).status,
    ).toBe(204);
    await newer.leave();
  });
});
