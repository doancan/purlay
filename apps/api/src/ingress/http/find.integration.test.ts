/**
 * `GET /api/workspaces/:workspaceId/find` through the HTTP surface (D-283 §4, D-285): one words asked of every search source of
 * every module that runs, answered as a group for each source. What each source finds, and in what order, is the module's and is
 * tested there; this file proves the door: the contract's shape, the refusals, the source of a module that is off answered
 * `off`, and that what the two sources find is the caller's to read in the caller's workspace. The fan-out itself, with a
 * third module's source, a slow one and one that throws, is `modules/find/find.integration.test.ts`; the crossing of workspaces
 * is in `cross-tenant.integration.test.ts`.
 *
 * @needs-modules chat, issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { FindResponse, messageId, SEARCH_QUERY_MAX, SEARCH_QUERY_MIN } from '@purlay/types';
import { createApp } from './app';
import { bundledModules, composeFor } from '../../composition';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { NOW, testDependencies } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

const asNobody = async (db: Executor, userId: string): Promise<string> =>
  `${SESSION_COOKIE}=${(await aSession(db, clock, userId)).token}`;

type Running = ReturnType<typeof composeFor>;

const call = async (
  db: Executor,
  path: string,
  cookie: string | undefined,
  composition: Running = composeFor(bundledModules, undefined),
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock, composition })).handle(
    new Request(`https://purlay.test${path}`, {
      headers: cookie === undefined ? {} : { cookie },
    }),
  );

const send = async (
  db: Executor,
  channelId: string,
  cookie: string,
  content: string,
): Promise<void> => {
  const response = await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ id: messageId(NOW), content }),
    }),
  );
  expect(response.status).toBe(201);
};

const anIssue = async (
  db: Executor,
  workspaceId: string,
  title: string,
  body = '',
): Promise<string> =>
  (
    await db
      .insertInto('issues')
      .values({ id: messageId(NOW), workspace_id: workspaceId, title, body })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

interface World {
  readonly room: Room;
  readonly alice: string;
  readonly bob: string;
  readonly carol: string;
}

/** A workspace of three, alice and bob in `general`, carol in the workspace and not in the channel. */
const aWorld = async (db: Executor, type: 'public' | 'private' = 'public'): Promise<World> => {
  const room = await aRoom(db, ['alice', 'bob'], { type, outsiders: ['carol'] });
  const userId = (name: 'alice' | 'bob'): string => room.members[name]?.userId ?? '';
  return {
    room,
    alice: await asNobody(db, userId('alice')),
    bob: await asNobody(db, userId('bob')),
    carol: await asNobody(db, room.outsiders['carol']?.userId ?? ''),
  };
};

const find = (world: World, words: string): string =>
  `/api/workspaces/${world.room.workspaceId}/find?q=${encodeURIComponent(words)}`;

const answer = async (response: Response): Promise<FindResponse> => {
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(Value.Check(FindResponse, body)).toBe(true);
  return body as FindResponse;
};

const titlesOf = (found: FindResponse, source: string): string[] =>
  found.groups.find((group) => group.source === source)?.hits.map((hit) => hit.title) ?? [];

describe('integration: find', () => {
  test('answers a group for each source in the contract’s shape, newest first', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await send(db, world.room.channelId, world.alice, 'the deploy is at noon');
      await anIssue(db, world.room.workspaceId, 'Deploy checklist', 'run the script at noon');
      const found = await answer(await call(db, find(world, '  DEPLOY '), world.bob));
      expect(found.groups.map((group) => group.source)).toEqual(['messages', 'issues']);
      expect(found.skipped).toEqual([]);
      expect(titlesOf(found, 'messages')).toEqual(['the deploy is at noon']);
      expect(titlesOf(found, 'issues')).toEqual(['Deploy checklist']);
      const [message] = found.groups[0]?.hits ?? [];
      expect(message?.target).toEqual({
        type: 'message',
        channelId: world.room.channelId,
        messageId: expect.any(String) as string,
      });
    });
  });

  test('a source that finds nothing is a group with no hits, not a skipped one', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const found = await answer(await call(db, find(world, 'nothing like it'), world.alice));
      expect(found.groups).toEqual([
        { source: 'messages', hits: [] },
        { source: 'issues', hits: [] },
      ]);
      expect(found.skipped).toEqual([]);
    });
  });

  test('refuses the words below the minimum and above the maximum, and no session', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const refused = async (words: string): Promise<number> =>
        (await call(db, find(world, words), world.alice)).status;
      expect(await refused('x'.repeat(SEARCH_QUERY_MIN - 1))).toBe(400);
      expect(await refused('x'.repeat(SEARCH_QUERY_MAX + 1))).toBe(400);
      expect(await refused('x'.repeat(SEARCH_QUERY_MIN))).toBe(200);
      expect(await refused('x'.repeat(SEARCH_QUERY_MAX))).toBe(200);
      expect((await call(db, find(world, 'deploy'), undefined)).status).toBe(401);
    });
  });

  test('finds what the caller may read: a private channel’s words are not an outsider’s', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, 'private');
      await send(db, world.room.channelId, world.alice, 'the secret deploy plan');
      const member = await answer(await call(db, find(world, 'deploy plan'), world.bob));
      expect(titlesOf(member, 'messages')).toEqual(['the secret deploy plan']);
      const outsider = await answer(await call(db, find(world, 'deploy plan'), world.carol));
      expect(titlesOf(outsider, 'messages')).toEqual([]);
      expect(JSON.stringify(outsider)).not.toContain('secret');
    });
  });

  test('never finds another workspace’s words or issues, with the same words in both', async () => {
    await withRollback(async (db) => {
      const mine = await aWorld(db);
      const theirs = await aWorld(db);
      await send(db, theirs.room.channelId, theirs.alice, 'their deploy is at dawn');
      await anIssue(db, theirs.room.workspaceId, 'Their deploy checklist');
      await send(db, mine.room.channelId, mine.alice, 'our deploy is at noon');
      await anIssue(db, mine.room.workspaceId, 'Our deploy checklist');
      const found = await answer(await call(db, find(mine, 'deploy'), mine.alice));
      expect(titlesOf(found, 'messages')).toEqual(['our deploy is at noon']);
      expect(titlesOf(found, 'issues')).toEqual(['Our deploy checklist']);
      const other = await call(db, find(theirs, 'deploy'), mine.alice);
      expect(other.status).toBe(404);
    });
  });

  test('a module that is off is answered off and its source is never asked', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await send(db, world.room.channelId, world.alice, 'the deploy is at noon');
      await anIssue(db, world.room.workspaceId, 'Deploy checklist');
      const chatOff = await answer(
        await call(db, find(world, 'deploy'), world.alice, composeFor(bundledModules, 'issues')),
      );
      expect(chatOff.groups.map((group) => group.source)).toEqual(['issues']);
      expect(chatOff.skipped).toEqual([{ source: 'messages', reason: 'off' }]);
      const issuesOff = await answer(
        await call(db, find(world, 'deploy'), world.alice, composeFor(bundledModules, 'chat')),
      );
      expect(issuesOff.groups.map((group) => group.source)).toEqual(['messages']);
      expect(issuesOff.skipped).toEqual([{ source: 'issues', reason: 'off' }]);
    });
  });
});
