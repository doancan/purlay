/**
 * A module's request has a deadline, and a failure in one module's handler is that request's alone (`MODULES.md` §7, D-269),
 * on a real database and a pool of its own.
 *
 * A request is made to wait without a clock: a lock on the table it reads, held by a connection of the test's own. Its
 * deadline passes, it is answered `504 REQUEST_TIMEOUT` in the error envelope with its request id, and the database is
 * told to cancel the statement it was waiting in, which is seen on the server and not assumed: the lock is still held, and
 * the statement's own limit is longer than this test waits.
 *
 * @needs-modules chat, issues
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  createDatabase,
  sql,
  type ClonedDatabase,
} from '@purlay/db';
import { chatModule } from '../../features/chat/module';
import { issuesModule } from '../../features/issues/module';
import { compose } from '../../composition';
import { fixedClock } from '../../platform/clock';
import { aRecordingLogger, NOW, testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp, type HttpApplication } from './app';

const POOL = 3;
const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);
const TEST_MS = 60_000;
/** The shortest a deadline may be, against issues' statement limit of five seconds. */
const DEADLINE_MS = 1_000;

const quickIssues = {
  ...issuesModule,
  manifest: { ...issuesModule.manifest, deadline: { ms: DEADLINE_MS } },
};

let cloned: ClonedDatabase;
let pool: ReturnType<typeof createDatabase>;
let app: HttpApplication;
let person: SignedInUser;
let workspaceId = '';
let channelId = '';
let flaky = false;
const logged = aRecordingLogger();
/** The queries of the pins read that the first call to fail should fail after they ran. */
const pinReads = new Set<unknown>();

const call = async (
  path: string,
  as: SignedInUser = person,
  fetcher: (request: Request) => Promise<Response> = async (request) => await app.handle(request),
  origin = ORIGIN,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; body: unknown; headers: Headers }> => {
  const response = await fetcher(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        cookie: as.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? null : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
};

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  pool = createDatabase({
    connectionString: cloned.connectionString,
    poolSize: POOL,
    connectionTimeoutMs: 20_000,
  });
  // The pool the handlers read, with a read of pins that fails once, after it ran, when a test arms it: a handler that
  // throws while it holds a connection.
  const database = pool.withPlugin({
    transformQuery: (args) => {
      if (flaky && JSON.stringify(args.node).includes('pinned_messages'))
        pinReads.add(args.queryId);
      return args.node;
    },
    transformResult: (args) => {
      if (flaky && pinReads.delete(args.queryId)) {
        flaky = false;
        return Promise.reject(new Error('the read failed under the handler'));
      }
      return Promise.resolve(args.result);
    },
  });
  const modules = compose([chatModule, quickIssues], [chatModule, quickIssues]);
  app = createApp(
    testDependencies({
      database,
      clock,
      composition: modules,
      log: logged.log,
      config: testConfig({ DATABASE_POOL_MAX: POOL }),
    }),
  );
  person = await aSignedInUser(cloned.db, clock, 'deadline-person');
  const slug = aUniqueSlug('deadline');
  const made = await call('/api/workspaces', person, undefined, ORIGIN, 'POST', {
    name: slug,
    slug,
  });
  workspaceId = (made.body as { id: string }).id;
  const channel = await call(
    `/api/workspaces/${workspaceId}/channels`,
    person,
    undefined,
    ORIGIN,
    'POST',
    { name: 'talk' },
  );
  channelId = (channel.body as { id: string }).id;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await pool.destroy();
  await cloned.drop();
}, DROP_HOOK_MS);

/** Whether the server has a statement waiting on a table of ours: what the deadline is meant to have ended. */
const statementsWaitingOnIssues = async (): Promise<number> =>
  Number(
    (
      await sql<{ n: string }>`select count(*)::text as n from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and state = 'active' and wait_event_type = 'Lock' and query ilike '%from "issues"%'`.execute(
        cloned.db,
      )
    ).rows[0]?.n ?? '0',
  );

/** Holds the issues table until `release()`, so that every read of it waits. */
const lockIssues = async (): Promise<{ release: () => Promise<void> }> => {
  let letGo: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    letGo = resolve;
  });
  const state = { locked: false };
  const transaction = cloned.db.transaction().execute(async (trx) => {
    await sql`lock table issues in access exclusive mode`.execute(trx);
    state.locked = true;
    await held;
  });
  const until = performance.now() + 30_000;
  while (!state.locked) {
    if (performance.now() > until) throw new Error('gave up waiting for the lock');
    await Bun.sleep(5);
  }
  return {
    release: async (): Promise<void> => {
      letGo();
      await transaction;
    },
  };
};

describe('integration: a module’s request that runs past its deadline', () => {
  test(
    'is answered REQUEST_TIMEOUT in the error envelope with its request id, and the statement it waited in is cancelled',
    async () => {
      const lock = await lockIssues();
      try {
        const started = performance.now();
        const answer = await call(`/api/workspaces/${workspaceId}/issues`);
        const took = performance.now() - started;
        expect(answer.status).toBe(504);
        expect(answer.body).toMatchObject({ error: { code: 'REQUEST_TIMEOUT' } });
        expect(answer.headers.get('x-request-id')).toMatch(/\S/);
        expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
        expect(took).toBeLessThan(4_500);
        // The statement was still waiting on the lock when it was answered; it is gone well before its own limit.
        const gone = performance.now() + 3_000;
        while ((await statementsWaitingOnIssues()) > 0) {
          if (performance.now() > gone)
            throw new Error('the statement was left waiting after the deadline');
          await Bun.sleep(25);
        }
        expect(
          logged.lines.some(
            (line) =>
              line['msg'] === 'request ran past its deadline' && line['module'] === 'issues',
          ),
        ).toBe(true);
      } finally {
        await lock.release();
      }
      // The connection and the share came back: the same request is answered now.
      expect((await call(`/api/workspaces/${workspaceId}/issues`)).status).toBe(200);
    },
    TEST_MS,
  );

  test(
    'is answered the same over a started server, which is where the framework’s hook is not the one `handle` runs',
    async () => {
      const port = app.listen(0);
      const lock = await lockIssues();
      try {
        const answer = await call(
          `/api/workspaces/${workspaceId}/issues`,
          person,
          async (request) => await fetch(request),
          `http://localhost:${String(port)}`,
        );
        expect(answer.status).toBe(504);
        expect(answer.body).toMatchObject({ error: { code: 'REQUEST_TIMEOUT' } });
      } finally {
        await lock.release();
        await app.stop(true);
      }
    },
    TEST_MS,
  );

  test('does not touch a request of the core or of a module without trouble, which has no deadline to meet', async () => {
    expect((await call('/api/me')).status).toBe(200);
    expect((await call(`/api/channels/${channelId}/pins`)).status).toBe(200);
  });
});

describe('integration: a handler that throws inside one module', () => {
  test(
    'is the standard INTERNAL answer, logged with its module, and leaves the share and the pool as they were',
    async () => {
      flaky = true;
      const failed = await call(`/api/channels/${channelId}/pins`);
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({
        error: { code: 'INTERNAL', message: 'Something went wrong.' },
      });
      expect(JSON.stringify(failed.body)).not.toContain('under the handler');
      const line = logged.lines.find(
        (each) => each['msg'] === 'request failed' && each['module'] === 'chat',
      );
      expect(line).toBeDefined();
      // Chat's share of a pool of three is one connection: had the failed request kept it, these would be refused as busy.
      for (let n = 0; n < 3; n += 1) {
        expect((await call(`/api/channels/${channelId}/pins`)).status).toBe(200);
      }
      // And another module's request is answered as it always was.
      expect((await call(`/api/workspaces/${workspaceId}/issues`)).status).toBe(200);
    },
    TEST_MS,
  );
});
