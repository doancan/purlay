/**
 * The seed, run against a real database inside a transaction that is rolled back: what it
 * leaves is what the real send path produced, and nothing it does survives the test.
 */
import { TEST_AUTH_SECRET } from '../testing/signed-in';
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Channel, type MeResponse, type Message } from '@purlay/types';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { createApp } from '../ingress/http/app';
import { fixedClock } from '../platform/clock';
import { SESSION_COOKIE } from '../platform/cookies';
import { revokeAllSessions } from '../modules/auth/sessions';
import { testConfig, testDependencies } from '../testing/doubles';
import { PERSONAS } from './demo-script';
import {
  assertDemoDatabase,
  freshPerson,
  freshSession,
  plannedMessages,
  seedDemo,
} from './demo-seed';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');

/**
 * A whole demo workspace sent through the API: about 1.3 s alone (measured 2026-10-12), past bun's
 * default 5 s under the full suite's load (#347). Bounded still, so a seed that hangs fails.
 */
const SEEDING_MS = 30_000;

describe('integration: the demo seed', () => {
  test(
    'sends every message through the API, and leaves the counters the send path keeps',
    async () => {
      await withRollback(async (db) => {
        const config = testConfig({
          DATABASE_URL: 'postgres://u:p@localhost:5432/purlay_demo_test',
        });
        const manifest = await seedDemo({ database: db, config, now: NOW });
        expect(manifest.counts.messages).toBe(plannedMessages());

        // Read it back as the viewer, the way a browser does.
        const app = createApp(testDependencies({ database: db, clock: fixedClock(NOW), config }));
        const get = async (path: string): Promise<unknown> => {
          const response = await app.handle(
            new Request(`${config.APP_URL}${path}`, {
              headers: { cookie: manifest.personas.dogancan.cookie },
            }),
          );
          expect(response.status).toBe(200);
          return await response.json();
        };

        const channels = (await get(
          `/api/workspaces/${manifest.workspace.id}/channels`,
        )) as Channel[];
        for (const channel of channels) expect(Value.Check(Channel, channel)).toBe(true);
        const byName = Object.fromEntries(
          channels.map((c) => [c.name ?? c.peer?.username ?? '?', c]),
        );

        // The private channel is not the viewer's; the empty one is theirs and empty.
        expect(channels.some((c) => c.id === manifest.channels.security)).toBe(false);
        expect(byName['design']?.lastMessageAt).toBeNull();

        // Read mid-channel: part of #deploys and part of #api are unread, and the mentions waited.
        expect(byName['deploys']?.state?.unreadCount).toBe(80);
        expect(byName['api']?.state?.unreadCount).toBeGreaterThan(5);
        expect(byName['api']?.state?.unreadMentionCount).toBeGreaterThanOrEqual(3);
        expect(byName['incidents']?.state?.unreadMentionCount).toBeGreaterThanOrEqual(1);
        expect(byName['alice']?.type).toBe('direct_message');
        expect(byName['alice']?.state?.unreadCount).toBe(2);

        // Keyset pagination has something to page through.
        const page = (await get(
          `/api/channels/${manifest.channels.deploys}/messages?limit=100`,
        )) as {
          data: unknown[];
          nextCursor: string | null;
        };
        expect(page.data).toHaveLength(100);
        expect(page.nextCursor).not.toBeNull();

        // Threads: one open with four replies, one resolved.
        const open = manifest.messages['backoff-question'];
        const resolved = manifest.messages['legacy-route'];
        const feed = (await get(`/api/channels/${manifest.channels.api}/messages?limit=100`)) as {
          data: Message[];
        };
        const rootOpen = feed.data.find((m) => m.id === open);
        const rootResolved = feed.data.find((m) => m.id === resolved);
        expect(rootOpen?.thread?.replyCount).toBe(4);
        expect(rootOpen?.thread?.resolvedAt).toBeNull();
        expect(rootResolved?.thread?.resolvedBy?.username).toBe('alice');
        expect(rootOpen?.reactions.length).toBeGreaterThan(0);

        // The outsiders are in no workspace, each signed in twice: two sessions, both live.
        for (const outsider of Object.values(manifest.outsiders)) {
          const [first, second] = outsider.tokens;
          expect(first).not.toBe(second);
          for (const token of outsider.tokens) {
            const response = await app.handle(
              new Request(`${config.APP_URL}/api/me`, {
                headers: { cookie: `${SESSION_COOKIE}=${token}` },
              }),
            );
            expect(response.status).toBe(200);
            const me = (await response.json()) as { user: { id: string }; memberships: unknown[] };
            expect(me.user.id).toBe(outsider.userId);
            expect(me.memberships).toEqual([]);
          }
        }
      });
    },
    SEEDING_MS,
  );

  test(
    'refuses a database that already has the people, rather than duplicating them',
    async () => {
      await withRollback(async (db) => {
        const config = testConfig({
          DATABASE_URL: 'postgres://u:p@localhost:5432/purlay_demo_test',
        });
        await seedDemo({ database: db, config, now: NOW });
        let message = '';
        await seedDemo({ database: db, config, now: NOW }).catch((error: unknown) => {
          message = error instanceof Error ? error.message : '';
        });
        expect(message).toContain('already exist');
      });
    },
    SEEDING_MS,
  );
});

describe('integration: a seed the API refuses', () => {
  test(
    'stops at the first refused request and says which, as whom, with what the API answered',
    async () => {
      await withRollback(async (db) => {
        const config = testConfig({
          DATABASE_URL: 'postgres://u:p@localhost:5432/purlay_demo_test',
        });
        // The workspace's address is taken, so the first request the seed makes is refused.
        await db.insertInto('workspaces').values({ name: 'Taken', slug: 'acme-eng' }).execute();
        let message = '';
        await seedDemo({ database: db, config, now: NOW }).catch((error: unknown) => {
          message = error instanceof Error ? error.message : '';
        });
        expect(message).toStartWith('POST /api/workspaces as dogancan answered 409:');
        expect(message).toContain('WORKSPACE_SLUG_TAKEN');
      });
    },
    SEEDING_MS,
  );
});

describe('integration: the database the seed will write to', () => {
  test.each(['purlay_demo', 'purlay_demo_two', 'purlay_e2e', 'purlay_e2e_4173'])(
    '%s is a scratch one',
    (name) => {
      expect(() => {
        assertDemoDatabase(`postgres://u:p@localhost:5432/${name}`);
      }).not.toThrow();
    },
  );

  test.each(['purlay', 'purlay_tok', 'production', 'purlay_demo/../x', 'demo', 'my_purlay_demo'])(
    '%s is refused, with its name in the message',
    (name) => {
      expect(() => {
        assertDemoDatabase(`postgres://u:p@localhost:5432/${name}`);
      }).toThrow(/refusing to seed/);
    },
  );

  test('seedDemo itself refuses before touching the database', async () => {
    await withRollback(async (db) => {
      const config = testConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/purlay' });
      let message = '';
      await seedDemo({ database: db, config, now: NOW }).catch((error: unknown) => {
        message = error instanceof Error ? error.message : '';
      });
      expect(message).toContain('refusing to seed "purlay"');
      expect(
        await db
          .selectFrom('users')
          .select('id')
          .where('username', 'in', Object.keys(PERSONAS))
          .execute(),
      ).toHaveLength(0);
    });
  });
});

describe('integration: a fresh session for a seeded person (#522 follow-up)', () => {
  test('is a new working session, so a test that signs a person out everywhere can run again', async () => {
    await withRollback(async (db) => {
      const config = testConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/purlay_e2e_test',
      });
      const manifest = await seedDemo({ database: db, config, now: NOW });
      const app = createApp(testDependencies({ database: db, clock: fixedClock(NOW), config }));
      const me = async (token: string): Promise<number> =>
        (
          await app.handle(
            new Request('http://localhost/api/me', {
              headers: { cookie: `${SESSION_COOKIE}=${token}` },
            }),
          )
        ).status;

      // Every session erin holds ends, as signing out everywhere ends them.
      await revokeAllSessions(db, manifest.outsiders.erin.userId);
      expect(await me(manifest.outsiders.erin.tokens[0])).toBe(401);

      const token = await freshSession(
        db,
        fixedClock(NOW),
        config.DATABASE_URL,
        'erin',
        TEST_AUTH_SECRET,
      );
      expect(await me(token)).toBe(200);
    });
  });

  test('is refused outside a scratch database, and for somebody who is not there', async () => {
    await withRollback(async (db) => {
      const refusal = async (url: string, who: string): Promise<string> =>
        await freshSession(db, fixedClock(NOW), url, who, TEST_AUTH_SECRET).then(
          () => 'no refusal',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      expect(await refusal('postgres://u:p@localhost:5432/purlay', 'erin')).toContain(
        'refusing to seed "purlay"',
      );
      expect(await refusal('postgres://u:p@localhost:5432/purlay_e2e_x', 'nobody')).toContain(
        'nobody called nobody',
      );
    });
  });
});

describe('integration: a fresh person, for a browser test that needs people nobody else spends', () => {
  test('is signed in, in no workspace, and refused outside a scratch database', async () => {
    await withRollback(async (db) => {
      const config = testConfig({
        DATABASE_URL: 'postgres://u:p@localhost:5432/purlay_e2e_test',
      });
      const app = createApp(testDependencies({ database: db, clock: fixedClock(NOW), config }));
      const person = await freshPerson(
        db,
        fixedClock(NOW),
        config.DATABASE_URL,
        'hana-test',
        TEST_AUTH_SECRET,
      );
      const response = await app.handle(
        new Request('http://localhost/api/me', {
          headers: { cookie: `${SESSION_COOKIE}=${person.token}` },
        }),
      );
      expect(response.status).toBe(200);
      const me = (await response.json()) as MeResponse;
      expect(me.user).toMatchObject({ id: person.userId, username: 'hana-test' });
      expect(me.memberships).toEqual([]);

      const refusal = await freshPerson(
        db,
        fixedClock(NOW),
        'postgres://u:p@localhost:5432/purlay',
        'hana-elsewhere',
        TEST_AUTH_SECRET,
      ).then(
        () => 'no refusal',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refusal).toContain('refusing to seed "purlay"');
    });
  });
});
