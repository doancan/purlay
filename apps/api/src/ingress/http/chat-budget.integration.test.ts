/**
 * Chat is held to a share of the database as issues is, and what it leaves is the others' (`MODULES.md` §7, D-266), on a
 * real database and a pool of its own: with chat's share full of requests that wait on a lock, the next chat request is
 * refused as the database being busy, while a core request and an issues request on the same pool are both answered.
 *
 * Chat's requests are made slow without a clock: a lock on the table a chat read ends at, held by a connection of the
 * test's own, so each one that gets a slot holds a connection until the lock is let go.
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
import { composition } from '../../composition';
import { chatBudget } from '../../features/chat/budget';
import { fixedClock } from '../../platform/clock';
import { NOW, testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp, type HttpApplication } from './app';

const POOL = 6;
const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);
const TEST_MS = 60_000;

let cloned: ClonedDatabase;
let pool: ReturnType<typeof createDatabase>;
let app: HttpApplication;
let person: SignedInUser;
let workspaceId = '';
let channelId = '';

const call = async (
  method: string,
  path: string,
  body?: unknown,
  as: SignedInUser = person,
): Promise<{ status: number; body: unknown }> => {
  const response = await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie: as.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
};

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  // The application's own pool, of the size the share is a third of, over the same database.
  pool = createDatabase({
    connectionString: cloned.connectionString,
    poolSize: POOL,
    connectionTimeoutMs: 20_000,
  });
  app = createApp(
    testDependencies({
      database: pool,
      clock,
      composition,
      config: testConfig({ DATABASE_POOL_MAX: POOL }),
    }),
  );
  person = await aSignedInUser(cloned.db, clock, 'budget-person');
  const slug = aUniqueSlug('budget');
  const made = await call('POST', '/api/workspaces', { name: slug, slug });
  workspaceId = (made.body as { id: string }).id;
  const channel = await call('POST', `/api/workspaces/${workspaceId}/channels`, { name: 'talk' });
  channelId = (channel.body as { id: string }).id;
}, CLONE_HOOK_MS);

afterAll(async () => {
  await pool.destroy();
  await cloned.drop();
}, DROP_HOOK_MS);

/** Resolves once `ready()` holds, or says what it was waiting for; a condition, never a pause. */
const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = performance.now() + 30_000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(5);
  }
};

describe('integration: chat over its share of the pool', () => {
  test(
    'a full share refuses the next request as the database being busy, and the core and issues are answered meanwhile',
    async () => {
      const share = chatBudget(POOL).maxConcurrent;
      const requests = share + 3;
      let release: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = false;
      let reads: Promise<{ status: number; body: unknown }>[] = [];
      // Another connection takes the table the pins are read from, so every read of them waits.
      const lock = cloned.db.transaction().execute(async (transaction) => {
        await sql`lock table pinned_messages in access exclusive mode`.execute(transaction);
        locked = true;
        await lockHeld;
      });
      try {
        await until('the lock', () => locked);
        const settled: { status: number; body: unknown }[] = [];
        reads = Array.from({ length: requests }, () =>
          call('GET', `/api/channels/${channelId}/pins`).then((answer) => {
            settled.push(answer);
            return answer;
          }),
        );
        // The ones over the share are refused; the ones inside it are still waiting on the lock.
        await until('the refusals', () => settled.length === requests - share);
        for (const answer of settled) {
          expect(answer.status).toBe(503);
          expect(answer.body).toMatchObject({
            error: {
              code: 'DATABASE_UNAVAILABLE',
              message: expect.stringContaining('chat') as string,
            },
          });
        }

        // What the pool keeps for the others: the core's own read, and a module that is not chat.
        expect((await call('GET', '/api/me')).status).toBe(200);
        expect((await call('GET', `/api/workspaces/${workspaceId}/issues`)).status).toBe(200);
        expect(settled).toHaveLength(requests - share);
      } finally {
        release();
        await lock;
      }
      // Let go of the lock, the ones that held a slot are answered, and the share is free again.
      const answers = await Promise.all(reads);
      expect(answers.filter((answer) => answer.status === 200)).toHaveLength(share);
      expect((await call('GET', `/api/channels/${channelId}/pins`)).status).toBe(200);
    },
    TEST_MS,
  );
});
