/**
 * What a person does: each action asks the API and teaches the cache the answer — and
 * only the answer. A failure writes nothing.
 */
import { memoryStorage } from '../testing/fakes';
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
  githubEvent: null,
  content: 'why 4s?',
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  parentId: null,
  thread: summary,
  reactions: [],
  mentions: [],
  attachments: [],
};
const state = { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 1 };
const channel: Channel = {
  id: CH,
  workspaceId: WS,
  name: 'api',
  topic: null,
  incident: null,
  codeRepository: null,
  onlyAdminsPost: false,
  type: 'public',
  lastMessageAt: null,
  state,
  notificationLevel: 'mentions',
  starred: false,
  peer: null,
  peers: [],
  memberCount: 1,
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

test('a delayed question save or refusal cannot overwrite a newer decision already received', async () => {
  for (const refuses of [false, true]) {
    const { client } = world();
    let answer: (message: Message) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const actions = createActions(
      anApi({
        setKnowledge: () =>
          new Promise<Message>((yes, no) => {
            answer = yes;
            reject = no;
          }),
      }),
      client,
    );
    const input = {
      version: 0,
      isQuestion: true,
      assigneeId: null,
      acceptedAnswerId: null,
      decisionNote: 'Mine',
      decisionUrl: null,
    };
    const writing = actions.setKnowledge(root, input).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rootInCache(client)?.thread?.knowledge?.decisionNote).toBe('Mine');
    const newer = {
      ...root,
      thread: {
        ...summary,
        knowledge: { ...input, version: 2, decisionNote: 'Newer', acceptedAnswer: null },
      },
    };
    client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [newer], nextCursor: null }],
    });
    if (refuses) reject(new ApiError(409, 'KNOWLEDGE_CONFLICT', 'Changed'));
    else
      answer({
        ...root,
        thread: { ...summary, knowledge: { ...input, version: 1, acceptedAnswer: null } },
      });
    await writing;
    expect(rootInCache(client)?.thread?.knowledge?.decisionNote).toBe('Newer');
    client.clear();
  }
});

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

describe('editing', () => {
  test('the new words are on screen before the server answers, and its answer is kept', async () => {
    const { client } = world();
    let answer: (message: Message) => void = () => undefined;
    const actions = createActions(
      anApi({
        editMessage: () =>
          new Promise<Message>((resolve) => {
            answer = resolve;
          }),
      }),
      client,
    );
    const editing = actions.edit(root, 'why 4 seconds?');
    expect(rootInCache(client)?.content).toBe('why 4 seconds?');
    expect(rootInCache(client)?.editedAt).not.toBeNull();
    answer({ ...root, content: 'why 4 seconds?', editedAt: '2026-09-09T09:00:00.000Z' });
    await editing;
    expect(rootInCache(client)?.editedAt).toBe('2026-09-09T09:00:00.000Z');
  });

  test('refused, the words go back to what they were, and the caller hears why', async () => {
    const { client } = world();
    const actions = createActions(
      anApi({ editMessage: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')) }),
      client,
    );
    let heard: unknown;
    await actions.edit(root, 'not mine to change').catch((error: unknown) => {
      heard = error;
    });
    expect(heard).toBeInstanceOf(ApiError);
    expect(rootInCache(client)?.content).toBe('why 4s?');
    expect(rootInCache(client)?.editedAt).toBeNull();
  });
});

describe('deleting', () => {
  test('a message with replies is its tombstone at once, and stays one', async () => {
    const { client } = world();
    const actions = createActions(anApi({ deleteMessage: () => Promise.resolve() }), client);
    const deleting = actions.remove(root);
    expect(rootInCache(client)?.deletedAt).not.toBeNull();
    expect(rootInCache(client)?.content).toBe('');
    await deleting;
    expect(rootInCache(client)?.deletedAt).not.toBeNull();
  });

  test('a message nobody answered leaves at once', async () => {
    const { client } = world();
    const lone = { ...root, thread: { ...summary, replyCount: 0 } };
    client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [lone], nextCursor: null }],
    });
    await createActions(anApi({ deleteMessage: () => Promise.resolve() }), client).remove(lone);
    expect(rootInCache(client)).toBeUndefined();
  });

  test('refused, the channel is read again from the server, and the caller hears why', async () => {
    const { client } = world();
    const actions = createActions(
      anApi({ deleteMessage: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')) }),
      client,
    );
    let heard: unknown;
    await actions.remove(root).catch((error: unknown) => {
      heard = error;
    });
    expect(heard).toBeInstanceOf(ApiError);
    expect(client.getQueryState(keys.messages(CH))?.isInvalidated).toBe(true);
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

  test('everywhere asks to end every session, and forgets the page the same way', async () => {
    const { client } = world();
    const asked: string[] = [];
    await createActions(
      anApi({
        signOut: () => {
          asked.push('here');
          return Promise.resolve();
        },
        signOutEverywhere: () => {
          asked.push('everywhere');
          return Promise.resolve();
        },
      }),
      client,
    ).signOut('everywhere');
    expect(asked).toEqual(['everywhere']);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });
});

describe('erasing one’s own account (D-139 §5)', () => {
  test('erases, then forgets the person here as signing out does; a refusal forgets nothing', async () => {
    const { client } = world();
    client.setQueryData(keys.me, { user, memberships: [] });
    const storage = memoryStorage({ 'purlay.draft.a': 'mine', 'purlay.theme': 'dark' });
    const refusal = new ApiError(403, 'REAUTHENTICATION_REQUIRED', 'old');
    const refused = await createActions(
      anApi({ eraseAccount: () => Promise.reject(refusal) }),
      client,
      storage,
    )
      .eraseAccount('alice')
      .catch((caught: unknown) => caught);
    expect(refused).toBe(refusal);
    expect(Object.keys(storage.data).sort()).toEqual(['purlay.draft.a', 'purlay.theme']);
    await createActions(
      anApi({ eraseAccount: () => Promise.resolve() }),
      client,
      storage,
    ).eraseAccount('alice');
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(Object.keys(storage.data)).toEqual(['purlay.theme']);
  });
});

describe('signing in by a link (D-138 §4)', () => {
  test('spends it, then forgets whoever this page held: the cache, and the drafts kept by conversation', async () => {
    const { client } = world();
    client.setQueryData(keys.me, { user, memberships: [] });
    const storage = memoryStorage({ 'purlay.draft.a': 'theirs', 'purlay.theme': 'dark' });
    const spent: string[] = [];
    await createActions(
      anApi({
        consumeEmailSignIn: (token) => {
          spent.push(token);
          return Promise.resolve();
        },
      }),
      client,
      storage,
    ).signInByLink('a'.repeat(64));
    expect(spent).toEqual(['a'.repeat(64)]);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(Object.keys(storage.data)).toEqual(['purlay.theme']);
  });

  test('a refused link forgets nothing', async () => {
    const { client } = world();
    client.setQueryData(keys.me, { user, memberships: [] });
    const storage = memoryStorage({ 'purlay.draft.a': 'mine' });
    const refusal = new ApiError(404, 'SIGN_IN_LINK_NOT_FOUND', 'no');
    const thrown = await createActions(
      anApi({ consumeEmailSignIn: () => Promise.reject(refusal) }),
      client,
      storage,
    )
      .signInByLink('a'.repeat(64))
      .catch((caught: unknown) => caught);
    expect(thrown).toBe(refusal);
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
    expect(Object.keys(storage.data)).toEqual(['purlay.draft.a']);
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

describe('a channel’s settings (D-123)', () => {
  const listed = (client: QueryClient): Channel[] | undefined =>
    client.getQueryData<Channel[]>(keys.channels(WS));

  test('a rename is the server’s name and topic in the list', async () => {
    const { client } = world();
    client.setQueryData<Channel[]>(keys.channels(WS), [channel]);
    const actions = createActions(
      anApi({
        updateChannel: () => Promise.resolve({ ...channel, name: 'genel-sohbet', topic: 'x' }),
      }),
      client,
    );
    await actions.updateChannel(CH, { name: 'genel-sohbet', topic: 'x' });
    expect(listed(client)?.[0]).toMatchObject({ name: 'genel-sohbet', topic: 'x' });
  });

  test('leaving takes the channel off the list, and a public one is asked for again; archiving takes it off', async () => {
    const { client } = world();
    const secret: Channel = { ...channel, id: MSG, type: 'private' };
    client.setQueryData<Channel[]>(keys.channels(WS), [channel, secret]);
    let asked = 0;
    const actions = createActions(
      anApi({
        leaveChannel: () => Promise.resolve(),
        archiveChannel: () => Promise.resolve(),
        channels: () => {
          asked += 1;
          return Promise.resolve([{ ...channel, state: null, notificationLevel: null }]);
        },
      }),
      client,
    );
    await actions.leaveChannel(secret);
    expect(listed(client)?.map((c) => c.id)).toEqual([CH]);
    expect(asked).toBe(0);
    await actions.leaveChannel(channel);
    expect(client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(true);
    client.setQueryData<Channel[]>(keys.channels(WS), [channel]);
    await actions.archiveChannel(CH);
    expect(listed(client)).toEqual([]);
  });

  test('a refusal writes nothing', async () => {
    const { client } = world();
    client.setQueryData<Channel[]>(keys.channels(WS), [channel]);
    const actions = createActions(
      anApi({
        leaveChannel: () => Promise.reject(new ApiError(409, 'LAST_CHANNEL_MEMBER', 'x')),
        archiveChannel: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'x')),
      }),
      client,
    );
    const heard: unknown[] = [];
    await actions.leaveChannel(channel).catch((error: unknown) => {
      heard.push(error);
    });
    await actions.archiveChannel(CH).catch((error: unknown) => {
      heard.push(error);
    });
    expect(heard.map((error) => error instanceof ApiError)).toEqual([true, true]);
    expect(listed(client)).toEqual([channel]);
  });
});
