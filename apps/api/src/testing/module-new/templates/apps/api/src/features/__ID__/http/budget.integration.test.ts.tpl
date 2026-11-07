/**
 * __PASCAL__ cannot starve chat of the database (`MODULES.md` §7, D-250 rule 7), on a real database and a pool of its own:
 * its requests are held to a share of the pool, a request over the share is refused as the database being busy, and a chat
 * write on the same pool is answered while the share is full.
 *
 * Its requests are made slow without a clock: a lock on the table they read, held by a connection of the test's own.
 *
 * @needs-modules chat, __ID__
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
import { composition } from '../../../composition';
import { __CAMEL__Budget } from '../budget';
import { fixedClock } from '../../../platform/clock';
import { NOW, testConfig, testDependencies } from '../../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../../testing/signed-in';
import { aUniqueSlug } from '../../../testing/users';
import { createApp, type HttpApplication } from '../../../ingress/http/app';

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
): Promise<{ status: number; body: unknown }> => {
  const response = await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie: person.cookie,
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

describe('integration: the share of the pool __ID__ may take', () => {
  test('is a third of it, at least one and never all of it but for a pool of one', () => {
    const shares = [1, 2, 3, 4, 6, 10, 30, 100].map((size) => __CAMEL__Budget(size).maxConcurrent);
    expect(shares).toEqual([1, 1, 1, 1, 2, 3, 10, 33]);
  });

  test(
    'a full share refuses the next request as the database being busy, and a chat write on the same pool is answered meanwhile',
    async () => {
      const share = __CAMEL__Budget(POOL).maxConcurrent;
      const requests = share + 4;
      let release: () => void = () => undefined;
      const lockHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked = false;
      let lists: Promise<{ status: number; body: unknown }>[] = [];
      const lock = cloned.db.transaction().execute(async (transaction) => {
        await sql`lock table __SNAKE__ in access exclusive mode`.execute(transaction);
        locked = true;
        await lockHeld;
      });
      try {
        await until('the lock', () => locked);
        const settled: { status: number; body: unknown }[] = [];
        lists = Array.from({ length: requests }, () =>
          call('GET', `/api/workspaces/${workspaceId}/__ID__`).then((answer) => {
            settled.push(answer);
            return answer;
          }),
        );
        await until('the refusals', () => settled.length === requests - share);
        for (const answer of settled) {
          expect(answer.status).toBe(503);
          expect(answer.body).toMatchObject({ error: { code: 'DATABASE_UNAVAILABLE' } });
        }
        const sent = await call('POST', `/api/channels/${channelId}/messages`, {
          id: messageId(NOW),
          content: 'sent while __ID__ holds its share',
        });
        expect(sent.status).toBe(201);
      } finally {
        release();
        await lock;
      }
      const answers = await Promise.all(lists);
      expect(answers.filter((answer) => answer.status === 200)).toHaveLength(share);
    },
    TEST_MS,
  );
});
