/**
 * A channel's repository feeds through HTTP (#79, D-134): connected is a `201` the contract parses,
 * disconnected a `204`; a body the contract refuses is a `400` and writes nothing. The contract's
 * repository pattern and the table's check are one rule: every name at the edges of the one is
 * written by the other, and every name the one refuses is never asked of the other.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { CreatedGitHubFeed, GitHubFeedList } from '@purlay/types';
import { SESSION_COOKIE } from '../../platform/cookies';
import { fixedClock } from '../../platform/clock';
import { aSession } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { testDependencies } from '../../testing/doubles';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

const anAdmin = async (db: Executor): Promise<{ call: Call; channelId: string }> => {
  const room = await aRoom(db, ['alice']);
  const { token } = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
  const app = createApp(testDependencies({ database: db, clock }));
  const call: Call = async (method, path, body) =>
    await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return { call, channelId: room.channelId };
};

const feedsIn = async (db: Executor, channelId: string): Promise<string[]> =>
  (
    await db
      .selectFrom('github_repo_feeds')
      .select('repository_full_name')
      .where('channel_id', '=', channelId)
      .execute()
  ).map((row) => row.repository_full_name);

describe('integration: a channel’s feeds over HTTP', () => {
  test('connected is a 201 the contract parses, listed as it was made, disconnected a 204', async () => {
    await withRollback(async (db) => {
      const { call, channelId } = await anAdmin(db);
      const made = await call('POST', `/api/channels/${channelId}/github-feeds`, {
        repository: 'Acme/API',
        events: ['push', 'release'],
      });
      expect(made.status).toBe(201);
      const created: unknown = await made.json();
      if (!Value.Check(CreatedGitHubFeed, created)) throw new Error('not a CreatedGitHubFeed');

      const listed = await call('GET', `/api/channels/${channelId}/github-feeds`);
      const feeds: unknown = await listed.json();
      expect(Value.Check(GitHubFeedList, feeds)).toBe(true);
      expect(feeds).toEqual([created.feed]);

      const gone = await call(
        'DELETE',
        `/api/channels/${channelId}/github-feeds/${created.feed.id}`,
      );
      expect([gone.status, await gone.text()]).toEqual([204, '']);
      expect(await feedsIn(db, channelId)).toEqual([]);
    });
  });

  test('a regenerated secret is a 200 the contract parses, for the same feed and address, a different secret, shown only there (#884)', async () => {
    await withRollback(async (db) => {
      const { call, channelId } = await anAdmin(db);
      const made: unknown = await (
        await call('POST', `/api/channels/${channelId}/github-feeds`, {
          repository: 'acme/api',
          events: ['push'],
        })
      ).json();
      if (!Value.Check(CreatedGitHubFeed, made)) throw new Error('not a CreatedGitHubFeed');
      const path = `/api/channels/${channelId}/github-feeds/${made.feed.id}/secret`;

      const response = await call('POST', path);
      expect(response.status).toBe(200);
      const again: unknown = await response.json();
      if (!Value.Check(CreatedGitHubFeed, again)) throw new Error('not a CreatedGitHubFeed');
      expect(again.feed).toEqual(made.feed);
      expect(again.webhookPath).toBe(made.webhookPath);
      expect(again.secret).not.toBe(made.secret);
      const listed = JSON.stringify(
        await (await call('GET', `/api/channels/${channelId}/github-feeds`)).json(),
      );
      expect(listed).not.toContain(again.secret);

      // Each regeneration is its own secret.
      const third: unknown = await (await call('POST', path)).json();
      if (!Value.Check(CreatedGitHubFeed, third)) throw new Error('not a CreatedGitHubFeed');
      expect(third.secret).not.toBe(again.secret);

      // No such feed, or not an id: not found, as a disconnect says it.
      for (const id of [crypto.randomUUID(), 'not-a-uuid']) {
        const missing = await call('POST', `/api/channels/${channelId}/github-feeds/${id}/secret`);
        expect(missing.status).toBe(404);
        expect(await missing.json()).toMatchObject({ error: { code: 'GITHUB_FEED_NOT_FOUND' } });
      }
    });
  });

  test('every name at the edges of the contract is one the table holds', async () => {
    const owner39 = `a${'b'.repeat(38)}`;
    const name100 = 'n'.repeat(100);
    const accepted = [
      `${owner39}/x`,
      `a/${name100}`,
      'a-b/x',
      'A1/x.y_z-w',
      'acme/.x',
      'acme/..x',
      'acme/x.',
    ];
    await withRollback(async (db) => {
      const { call, channelId } = await anAdmin(db);
      for (const repository of accepted) {
        const response = await call('POST', `/api/channels/${channelId}/github-feeds`, {
          repository,
          events: ['push'],
        });
        expect({ repository, status: response.status }).toEqual({ repository, status: 201 });
      }
      expect((await feedsIn(db, channelId)).sort()).toEqual(
        accepted.map((name) => name.toLowerCase()).sort(),
      );
    });
  });

  test('a body the contract refuses is a 400, and nothing is written', async () => {
    const refused: unknown[] = [
      { repository: `a${'b'.repeat(39)}/x`, events: ['push'] }, // an owner of 40
      { repository: `a/${'n'.repeat(101)}`, events: ['push'] }, // a name of 101
      { repository: '-acme/x', events: ['push'] },
      { repository: 'ac_me/x', events: ['push'] },
      { repository: 'ac.me/x', events: ['push'] },
      { repository: 'acme/.', events: ['push'] },
      { repository: 'acme/..', events: ['push'] },
      { repository: 'acme', events: ['push'] },
      { repository: 'acme/x/y', events: ['push'] },
      { repository: 'acme/x', events: [] },
      { repository: 'acme/x', events: ['deployment'] },
      { repository: 'acme/x', events: ['push', 'push'] },
      { repository: 'acme/x', events: ['push', 'pull_request', 'issues', 'release', 'push'] },
      { repository: 'acme/x', events: ['push'], secret: 'mine' },
      { events: ['push'] },
    ];
    await withRollback(async (db) => {
      const { call, channelId } = await anAdmin(db);
      for (const body of refused) {
        const response = await call('POST', `/api/channels/${channelId}/github-feeds`, body);
        expect({ body, status: response.status, code: await response.json() }).toEqual({
          body,
          status: 400,
          code: { error: expect.objectContaining({ code: 'VALIDATION_FAILED' }) as unknown },
        });
      }
      expect(await feedsIn(db, channelId)).toEqual([]);
    });
  });
});
