/**
 * Issues cannot starve chat of the database (`MODULES.md` §7, D-250 rule 7), on a real database and a pool of its
 * own: issues' requests are held to a share of the pool, a request over the share is refused as the database being
 * busy, and a chat write on the same pool is answered while the share is full.
 *
 * Issues' requests are made slow without a clock: a lock on the table they read, held by a connection of the
 * test's own, so each one that gets a slot holds a connection until the lock is let go. Nothing here is a time
 * limit; what is asserted is what had happened when each answer came.
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
import { messageId } from '@purlay/types';
import { composition } from '../../composition';
import { issuesBudget } from '../../features/issues/budget';
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
let outsider: SignedInUser;
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
  outsider = await aSignedInUser(cloned.db, clock, 'budget-outsider');
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

/** Every request the issues routes answer, as a signed-in person who is not in the workspace makes it. */
const asOutsider = async (path: string, method = 'GET', body?: unknown): Promise<number> =>
  (await call(method, `/api/workspaces/${workspaceId}${path}`, body, outsider)).status;

describe('integration: the share of the pool issues may take', () => {
  test('is a third of it, at least one and never all of it but for a pool of one', () => {
    const shares = [1, 2, 3, 4, 6, 10, 30, 100].map((size) => issuesBudget(size).maxConcurrent);
    expect(shares).toEqual([1, 1, 1, 1, 2, 3, 10, 33]);
    for (const size of [2, 3, 4, 6, 10, 30, 100]) {
      expect(issuesBudget(size).maxConcurrent).toBeLessThan(size);
    }
  });
});

describe('integration: issues over the share of the pool', () => {
  test(
    'a full share refuses the next request as the database being busy, and a chat write on the same pool is answered meanwhile',
    async () => {
      const share = issuesBudget(POOL).maxConcurrent;
      const requests = share + 4;
      let release: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = false;
      let lists: Promise<{ status: number; body: unknown }>[] = [];
      // Another connection takes the issues table, so every statement that reads it waits.
      const lock = cloned.db.transaction().execute(async (transaction) => {
        await sql`lock table issues in access exclusive mode`.execute(transaction);
        locked = true;
        await lockHeld;
      });
      try {
        await until('the lock', () => locked);
        const settled: { status: number; body: unknown }[] = [];
        lists = Array.from({ length: requests }, () =>
          call('GET', `/api/workspaces/${workspaceId}/issues`).then((answer) => {
            settled.push(answer);
            return answer;
          }),
        );
        // The ones over the share are refused; the ones inside it are still waiting on the lock.
        await until('the refusals', () => settled.length === requests - share);
        for (const answer of settled) {
          expect(answer.status).toBe(503);
          expect(answer.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
        }

        // The pool still has the connections issues may not have: a chat write is answered with the share full.
        const sent = await call('POST', `/api/channels/${channelId}/messages`, {
          id: messageId(NOW),
          content: 'sent while issues hold their share',
        });
        expect(sent.status).toBe(201);
        expect(settled).toHaveLength(requests - share);
      } finally {
        release();
        await lock;
      }
      // Let go of the lock, the ones that held a slot are answered, and the share is free again.
      const answers = await Promise.all(lists);
      expect(answers.filter((answer) => answer.status === 200)).toHaveLength(share);
      expect((await call('GET', `/api/workspaces/${workspaceId}/issues`)).status).toBe(200);
    },
    TEST_MS,
  );

  test(
    'a person who is not in the workspace holds no slot: with the share full they are told the workspace is not there, not that the database is busy',
    async () => {
      const share = issuesBudget(POOL).maxConcurrent;
      let release: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = false;
      let holders: Promise<{ status: number; body: unknown }>[] = [];
      const lock = cloned.db.transaction().execute(async (transaction) => {
        await sql`lock table issues in access exclusive mode`.execute(transaction);
        locked = true;
        await lockHeld;
      });
      try {
        await until('the lock', () => locked);
        let started = 0;
        holders = Array.from({ length: share }, () => {
          started += 1;
          return call('GET', `/api/workspaces/${workspaceId}/issues`);
        });
        await until('the share to be taken', () => started === share);
        // The members' requests hold every slot, so a request that took one first would be refused as busy.
        const statuses = [
          await asOutsider('/issues'),
          await asOutsider('/issues', 'POST', { title: 'not theirs to make' }),
          await asOutsider(`/issues/${messageId(NOW)}`, 'PATCH', { title: 'x' }),
          await asOutsider(`/issues/${messageId(NOW)}`, 'DELETE'),
        ];
        expect(statuses).toEqual([404, 404, 404, 404]);
      } finally {
        release();
        await lock;
      }
      const answers = await Promise.all(holders);
      expect(answers.map((answer) => answer.status)).toEqual(
        Array.from({ length: share }, () => 200),
      );
    },
    TEST_MS,
  );
});
