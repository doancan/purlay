/**
 * Two API processes of one cluster, each the real entry point started as an operating system starts it, on one database and no
 * Redis (D-296): a module the administrator stops through one process, or through the command, is turned away by the other within
 * the TTL without anyone telling it, and what a resume brings back is served by both again. Redis carries none of it: correctness
 * does not depend on it, which this holds by not having one.
 *
 * The part that does need Redis — a stop waits for a process that does not read the stops — is
 * `suspension-two-processes.redis.integration.test.ts`.
 *
 * @needs-modules chat, issues
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { DEVELOPMENT_ENCRYPTION_KEY } from './platform/config';
import { systemClock } from './platform/clock';
import { SUSPENSION_TTL_MS } from './platform/suspended-modules';
import {
  eventually,
  killClusterNodes,
  startClusterNode,
  untilReady,
  type ClusterNode,
} from './testing/cluster-node';
import { aSignedInUser, type SignedInUser } from './testing/signed-in';
import { aUniqueSlug } from './testing/users';

const BOOT_MS = 30_000;
/** The TTL, and what a loaded runner adds to a timer and a query. */
const BELIEVED_MS = SUSPENSION_TTL_MS + 2_500;

let cloned: ClonedDatabase;
const started: ClusterNode[] = [];

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterEach(async () => {
  await killClusterNodes(started.splice(0));
});
afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const aNode = (): ClusterNode => {
  const node = startClusterNode({ databaseUrl: cloned.connectionString });
  started.push(node);
  return node;
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

const cluster = async (): Promise<{
  readonly one: ClusterNode;
  readonly two: ClusterNode;
  readonly operator: SignedInUser;
  readonly workspaceId: string;
}> => {
  const [one, two] = [aNode(), aNode()];
  await Promise.all([untilReady(one, BOOT_MS), untilReady(two, BOOT_MS)]);
  const operator = await aSignedInUser(cloned.db, systemClock, 'process-op');
  await cloned.db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', operator.userId)
    .execute();
  const slug = aUniqueSlug('stop');
  const made = await call(one, 'POST', '/api/workspaces', operator, { name: slug, slug });
  expect(made.status).toBe(201);
  return { one, two, operator, workspaceId: (made.body as { id: string }).id };
};

const issuesStatus = async (
  node: ClusterNode,
  workspaceId: string,
  who: SignedInUser,
): Promise<number> =>
  (await call(node, 'GET', `/api/workspaces/${workspaceId}/issues`, who)).status;

/** Waits for a process to answer `status`, and says how long it took. */
const believes = async (
  node: ClusterNode,
  workspaceId: string,
  who: SignedInUser,
  status: number,
): Promise<number> => {
  const started = performance.now();
  await eventually(
    `a process answers ${String(status)} for the issues of a workspace`,
    async () => (await issuesStatus(node, workspaceId, who)) === status,
    BELIEVED_MS,
  );
  return performance.now() - started;
};

describe('integration: two API processes on one database', () => {
  test('a stop through one process is believed by the other within the TTL, with no word from the first, and so is the resume', async () => {
    const { one, two, operator, workspaceId } = await cluster();
    expect(await issuesStatus(one, workspaceId, operator)).toBe(200);
    expect(await issuesStatus(two, workspaceId, operator)).toBe(200);

    const stopped = await call(one, 'POST', '/api/server/modules/issues/suspension', operator, {
      state: 'suspended',
      reason: 'misbehaving in production',
    });
    expect(stopped.status).toBe(200);
    // The process that wrote it believes it at once; the other when its cache is older than the TTL.
    expect(await issuesStatus(one, workspaceId, operator)).toBe(404);
    const waited = await believes(two, workspaceId, operator, 404);
    expect(waited).toBeLessThanOrEqual(BELIEVED_MS);
    const me = (await call(two, 'GET', '/api/me', operator)).body as { modules: string[] };
    expect(me.modules).not.toContain('issues');
    expect(me.modules).toContain('chat');

    // The data is where it was, and the other process lifts it as it found it.
    const resumed = await call(two, 'POST', '/api/server/modules/issues/suspension', operator, {
      state: 'running',
    });
    expect(resumed.status).toBe(200);
    expect(await issuesStatus(two, workspaceId, operator)).toBe(200);
    await believes(one, workspaceId, operator, 200);
  }, 120_000);

  test('the command stops a module for both processes and lets it run again, with the processes left running', async () => {
    const { one, two, operator, workspaceId } = await cluster();
    const command = (...args: string[]): { code: number; out: string } => {
      // This test has no Redis: a REDIS_URL of the runner's would make the command ask for --cluster-ready.
      const rest = { ...process.env };
      delete rest['REDIS_URL'];
      const done = Bun.spawnSync(
        ['bun', '--no-env-file', 'run', `${import.meta.dir}/cli/module-suspension.ts`, ...args],
        {
          env: {
            ...rest,
            APP_URL: 'https://purlay.test',
            ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
            DATABASE_URL: cloned.connectionString,
          },
        },
      );
      return { code: done.exitCode, out: done.stdout.toString() };
    };
    expect(command('suspend', 'issues', '--reason', 'stopped from the command').code).toBe(0);
    await believes(one, workspaceId, operator, 404);
    await believes(two, workspaceId, operator, 404);
    expect(one.process.exitCode).toBeNull();
    expect(two.process.exitCode).toBeNull();

    expect(command('resume', 'issues').code).toBe(0);
    await believes(one, workspaceId, operator, 200);
    await believes(two, workspaceId, operator, 200);
  }, 120_000);
});
