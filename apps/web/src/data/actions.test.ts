/**
 * What a person does: each action asks the API and teaches the cache the answer — and
 * only the answer. A failure writes nothing.
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Channel, Message, MessagePage } from '@purlay/types';
import { anApi } from '../testing/fake-api';
import { createActions } from './actions';
import { ApiError } from './errors';
import { keys } from './keys';

type Pages = InfiniteData<MessagePage, string | undefined>;

const WS = '00000000-0000-4000-8000-0000000000a1';
const CH = '00000000-0000-4000-8000-0000000000c1';
const MSG = '0199155c-6200-7b7f-8c11-000000000001';
const user = {
  id: '00000000-0000-4000-8000-0000000000e1',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
};
const summary = {
  replyCount: 2,
  lastReplyAt: '2026-09-09T08:01:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
};
const root: Message = {
  id: MSG,
  channelId: CH,
  sender: user,
  content: 'why 4s?',
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  parentId: null,
  thread: summary,
  reactions: [],
  mentions: [],
};
const state = { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 1 };
const channel: Channel = {
  id: CH,
  workspaceId: WS,
  name: 'api',
  topic: null,
  type: 'public',
  lastMessageAt: null,
  state,
  peer: null,
};

const world = (): { client: QueryClient } => {
  const client = new QueryClient();
  client.setQueryData<Pages>(keys.messages(CH), {
    pageParams: [undefined],
    pages: [{ data: [root], nextCursor: null }],
  });
  client.setQueryData<Channel[]>(keys.channels(WS), []);
  return { client };
};
const rootInCache = (client: QueryClient): Message | undefined =>
  client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[0];

describe('reactions', () => {
  test("the cache takes the server's whole set, for a reaction added and one taken back", async () => {
    const { client } = world();
    const actions = createActions(
      anApi({
        react: () => Promise.resolve({ reactions: [{ emoji: '👍', userIds: [user.id] }] }),
        unreact: () => Promise.resolve({ reactions: [] }),
      }),
      client,
    );
    await actions.react(root, '👍');
    expect(rootInCache(client)?.reactions).toEqual([{ emoji: '👍', userIds: [user.id] }]);
    await actions.unreact(root, '👍');
    expect(rootInCache(client)?.reactions).toEqual([]);
  });
});

describe('resolution', () => {
  test('resolving writes the resolved root everywhere it is shown, and reopening undoes it', async () => {
    const { client } = world();
    const resolved = {
      ...root,
      thread: { ...summary, resolvedAt: '2026-09-09T09:00:00.000Z', resolvedBy: user },
    };
    const actions = createActions(
      anApi({ resolve: () => Promise.resolve(resolved), reopen: () => Promise.resolve(root) }),
      client,
    );
    await actions.resolve(root);
    expect(rootInCache(client)?.thread?.resolvedBy).toEqual(user);
    await actions.reopen(root);
    expect(rootInCache(client)?.thread?.resolvedAt).toBeNull();
  });

  test('a message that comes back with no summary is written without asking the open questions again', async () => {
    const { client } = world();
    client.setQueryData(keys.unresolved(WS), { pageParams: [], pages: [] });
    const reply = { ...root, thread: null };
    await createActions(anApi({ resolve: () => Promise.resolve(reply) }), client).resolve(root);
    expect(client.getQueryState(keys.unresolved(WS))?.isInvalidated).toBe(false);
  });
});

describe('reading', () => {
  test('the channel takes the position and counters the server answered with', async () => {
    const { client } = world();
    client.setQueryData<Channel[]>(keys.channels(WS), [
      { ...channel, state: { ...state, unreadCount: 9 } },
    ]);
    const next = { lastReadMessageId: MSG, unreadCount: 0, unreadMentionCount: 0 };
    await createActions(anApi({ markRead: () => Promise.resolve(next) }), client).markRead(CH, MSG);
    expect(client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.state).toEqual(next);
  });
});

describe('channels and people', () => {
  test('a created, joined or opened channel is in the list once, and is returned', async () => {
    const { client } = world();
    const dm: Channel = {
      ...channel,
      id: '00000000-0000-4000-8000-0000000000c2',
      name: null,
      type: 'direct_message',
      peer: user,
    };
    const actions = createActions(
      anApi({
        createChannel: () => Promise.resolve(channel),
        joinChannel: () => Promise.resolve(channel),
        openDirectMessage: () => Promise.resolve(dm),
      }),
      client,
    );
    expect(await actions.createChannel(WS, { name: 'api' })).toBe(channel);
    expect(await actions.joinChannel(CH)).toBe(channel);
    expect(await actions.openDirectMessage(WS, user.id)).toBe(dm);
    expect(client.getQueryData<Channel[]>(keys.channels(WS))?.map((c) => c.id)).toEqual([
      CH,
      dm.id,
    ]);
  });

  test('a new workspace makes the identity answer stale', async () => {
    const { client } = world();
    client.setQueryData(keys.me, { user, memberships: [] });
    const workspace = { id: WS, name: 'acme', slug: 'acme', avatarUrl: null };
    const made = await createActions(
      anApi({ createWorkspace: () => Promise.resolve(workspace) }),
      client,
    ).createWorkspace({ name: 'acme', slug: 'acme' });
    expect(made).toBe(workspace);
    expect(client.getQueryState(keys.me)?.isInvalidated).toBe(true);
  });
});

describe('signing out', () => {
  test('asks, then forgets everything: the next person on this page inherits nothing', async () => {
    const { client } = world();
    await createActions(anApi({ signOut: () => Promise.resolve() }), client).signOut();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('a failure', () => {
  test('is thrown as it is and writes nothing', async () => {
    const { client } = world();
    const refusal = new ApiError(404, 'MESSAGE_NOT_FOUND', 'gone');
    const actions = createActions(
      anApi({ react: () => Promise.reject(refusal), signOut: () => Promise.reject(refusal) }),
      client,
    );
    const error = await actions.react(root, '👍').catch((e: unknown) => e);
    expect(error).toBe(refusal);
    expect(rootInCache(client)?.reactions).toEqual([]);
    await actions.signOut().catch(() => undefined);
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
  });
});
