/**
 * "Mark every channel read" (D-238) through the HTTP surface against a database of its own, so that
 * requests at once really are at once: what is read, what is answered, who is refused, and that two
 * at once — and one beside a read of one channel — both finish.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { messageId, type ReadAllChannelsResponse } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aUniqueSlug } from '../../testing/users';

const origin = 'https://purlay.test';
const NOW = new Date('2026-11-01T09:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
let app: HttpApplication;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  app = createApp(
    testDependencies({ database: cloned.db, clock, config: testConfig({ APP_URL: origin }) }),
  );
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const call = async (
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
): Promise<Response> =>
  await app.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        ...(cookie === undefined ? {} : { cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const idOf = async (response: Response): Promise<string> =>
  ((await response.json()) as { id: string }).id;

interface Workspace {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  /** Channels Alice and Bob are both in. */
  readonly channels: readonly string[];
}

let moment = 0;

/** Alice owns a workspace with three channels; Bob is in it and in each. */
const aWorkspace = async (): Promise<Workspace> => {
  const alice = await aSignedInUser(cloned.db, clock, 'ra-alice');
  const bob = await aSignedInUser(cloned.db, clock, 'ra-bob');
  const slug = aUniqueSlug('ra');
  const workspaceId = await idOf(
    await call('POST', '/api/workspaces', alice.cookie, { name: 'Şirket içi', slug }),
  );
  await cloned.db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channels: string[] = [];
  for (const name of ['ops', 'dev', 'genel-sohbet']) {
    const channelId = await idOf(
      await call('POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, { name }),
    );
    expect((await call('POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
    channels.push(channelId);
  }
  return { alice, bob, workspaceId, channels };
};

/** A message sent by a real send, so the counters move as they do in use. */
const say = async (
  by: SignedInUser,
  channelId: string,
  content: string,
  parentId?: string,
): Promise<string> => {
  moment += 1;
  const id = messageId(new Date(NOW.getTime() + moment));
  const response = await call('POST', `/api/channels/${channelId}/messages`, by.cookie, {
    id,
    content,
    ...(parentId === undefined ? {} : { parentId }),
  });
  expect(response.status).toBe(201);
  return id;
};

const readAll = async (workspaceId: string, cookie?: string): Promise<Response> =>
  await call('PUT', `/api/workspaces/${workspaceId}/read`, cookie);

interface Listed {
  readonly id: string;
  readonly state: {
    readonly lastReadMessageId: string | null;
    readonly unreadCount: number;
    readonly unreadMentionCount: number;
  } | null;
}

const statesOf = async (space: Workspace, who: SignedInUser): Promise<Map<string, unknown>> => {
  const response = await call('GET', `/api/workspaces/${space.workspaceId}/channels`, who.cookie);
  const listed = (await response.json()) as Listed[];
  return new Map(listed.map((channel) => [channel.id, channel.state]));
};

describe('integration: marking every channel read (D-238)', () => {
  test('reads every channel with something unread, and the channel list says so', async () => {
    const space = await aWorkspace();
    const [ops, dev, quiet] = space.channels as [string, string, string];
    await say(space.bob, ops, 'Dağıtım bitti 🚀');
    const opsNewest = await say(space.bob, ops, `@${space.alice.username} göz atar mısın?`);
    const devNewest = await say(space.bob, dev, 'merged');
    const quietBefore = (await statesOf(space, space.alice)).get(quiet);

    const response = await readAll(space.workspaceId, space.alice.cookie);

    expect(response.status).toBe(200);
    const body = (await response.json()) as ReadAllChannelsResponse;
    expect(body.data).toEqual(
      [
        {
          channelId: ops,
          state: { lastReadMessageId: opsNewest, unreadCount: 0, unreadMentionCount: 0 },
        },
        {
          channelId: dev,
          state: { lastReadMessageId: devNewest, unreadCount: 0, unreadMentionCount: 0 },
        },
      ].sort((a, b) => a.channelId.localeCompare(b.channelId)),
    );
    const after = await statesOf(space, space.alice);
    expect(after.get(ops)).toEqual(body.data.find((each) => each.channelId === ops)?.state);
    expect(after.get(quiet)).toEqual(quietBefore);
    // The mention is read in the inbox too: it was a root the feed has now been read past.
    const inbox = await call(
      'GET',
      `/api/notifications?workspaceId=${space.workspaceId}&unreadOnly=true`,
      space.alice.cookie,
    );
    expect(((await inbox.json()) as { data: unknown[] }).data).toEqual([]);
    // Bob's own numbers are his: nothing of Alice's reading touches them.
    expect((await statesOf(space, space.bob)).get(ops)).toMatchObject({ unreadCount: 0 });
  });

  test('an answer waiting in a thread stays unread, and is answered so (D-147)', async () => {
    const space = await aWorkspace();
    const [ops] = space.channels as [string];
    const root = await say(space.alice, ops, 'Who owns the deploy?');
    const answer = await say(space.bob, ops, 'I do', root);

    const body = (await (
      await readAll(space.workspaceId, space.alice.cookie)
    ).json()) as ReadAllChannelsResponse;

    expect(body.data).toEqual([
      {
        channelId: ops,
        state: { lastReadMessageId: answer, unreadCount: 1, unreadMentionCount: 1 },
      },
    ]);
  });

  test('again, with nothing unread, answers nothing and changes nothing', async () => {
    const space = await aWorkspace();
    const [ops] = space.channels as [string];
    await say(space.bob, ops, 'one');
    expect((await readAll(space.workspaceId, space.alice.cookie)).status).toBe(200);
    const before = await statesOf(space, space.alice);

    const again = await readAll(space.workspaceId, space.alice.cookie);

    expect(again.status).toBe(200);
    expect(((await again.json()) as ReadAllChannelsResponse).data).toEqual([]);
    expect(await statesOf(space, space.alice)).toEqual(before);
  });

  test('signed out is 401; another workspace, or no workspace at all, is the same 404', async () => {
    const space = await aWorkspace();
    const [ops] = space.channels as [string];
    await say(space.bob, ops, 'still unread');
    const stranger = await aSignedInUser(cloned.db, clock, 'ra-stranger');
    const before = await statesOf(space, space.alice);

    expect((await readAll(space.workspaceId)).status).toBe(401);
    for (const [cookie, workspaceId] of [
      [stranger.cookie, space.workspaceId],
      [space.alice.cookie, '0199155c-6200-7b7f-8c11-2a4d3f9e1b70'],
      [space.alice.cookie, 'not-a-workspace'],
    ] as const) {
      const refused = await readAll(workspaceId, cookie);
      expect(refused.status).toBe(404);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'WORKSPACE_NOT_FOUND',
      );
    }
    expect(await statesOf(space, space.alice)).toEqual(before);
  });

  test('two at once, and a read of one channel beside them, all finish with everything read', async () => {
    const space = await aWorkspace();
    const newest = new Map<string, string>();
    for (const channelId of space.channels) {
      for (const word of ['bir', 'iki', 'üç']) {
        newest.set(channelId, await say(space.bob, channelId, word));
      }
    }
    const [first] = space.channels as [string];

    const answers = await Promise.all([
      readAll(space.workspaceId, space.alice.cookie),
      readAll(space.workspaceId, space.alice.cookie),
      call('PUT', `/api/channels/${first}/read`, space.alice.cookie, {
        lastReadMessageId: newest.get(first),
      }),
    ]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
    const after = await statesOf(space, space.alice);
    for (const channelId of space.channels) {
      expect(after.get(channelId)).toEqual({
        lastReadMessageId: newest.get(channelId),
        unreadCount: 0,
        unreadMentionCount: 0,
      });
    }
  });
});
