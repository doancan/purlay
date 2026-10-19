/**
 * The contract, checked at runtime.
 *
 * These schemas exist to validate, not only to type — one definition doing both
 * (`ARCHITECTURE.md` §2). Compiling proves the second half; this proves the
 * first.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { AppErrorBody, ErrorCode } from './errors';
import {
  ATTACHMENTS_PER_MESSAGE_MAX,
  GITHUB_EVENT_TEXT_MAX,
  GitHubEvent,
  PUSH_COMMITS_LISTED_MAX,
  PUSH_COMMITS_SHOWN_MAX,
  GIT_REF_NAME_MAX,
  Channel,
  CurrentUser,
  GitHubLink,
  Message,
  User,
} from './models';
import { ClientFrame, MessageSendFrame, ServerFrame } from './events';
import { messageId } from './message-id';
import {
  CreateDirectMessageRequest,
  MeResponse,
  MessagePage,
  MessageWindow,
  NotificationQuery,
  PAGE_LIMIT,
  ReadNotificationsRequest,
  SetDeepWorkRequest,
  SetNotificationLevelRequest,
  Page,
  ReactionsResponse,
  ReadChannelRequest,
  ReadThreadRequest,
  AddChannelMemberRequest,
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  SearchQuery,
  CreateChannelRequest,
  EditMessageRequest,
  SendMessageRequest,
  ThreadPage,
  UnresolvedPage,
} from './api';
import * as api from './api';
import { Type } from '@sinclair/typebox';

const id = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const when = '2026-09-09T08:00:00.000Z';
const user = { id, username: 'alice', displayName: 'Alice', avatarUrl: null };

describe('models', () => {
  test('a user validates', () => {
    expect(Value.Check(User, user)).toBe(true);
  });

  /**
   * The email is the identity anchor (D-11). Broadcasting it to everyone in a
   * workspace is a disclosure nobody asked for, so the public shape does not
   * carry it and the self shape does.
   */
  test('the public user shape has no email, and the self shape does', () => {
    expect(Object.keys(User.properties)).not.toContain('email');
    expect(Object.keys(CurrentUser.properties)).toContain('email');
  });

  test('a direct message may have no name; a named channel may not be nameless', () => {
    const dm = {
      id,
      workspaceId: id,
      name: null,
      topic: null,
      type: 'direct_message',
      lastMessageAt: null,
      state: null,
      notificationLevel: null,
      starred: false,
      incident: null,
      peer: user,
      peers: [user],
    };
    expect(Value.Check(Channel, dm)).toBe(true);
    expect(Value.Check(Channel, { ...dm, type: 'nonsense' })).toBe(false);
    // The caller's level is one of the three, or null when they are not a member (D-107).
    expect(Value.Check(Channel, { ...dm, notificationLevel: 'all' })).toBe(true);
    expect(Value.Check(Channel, { ...dm, notificationLevel: 'loud' })).toBe(false);
  });

  test('a message carries its sender, not a sender id to resolve later', () => {
    const message = {
      id,
      channelId: id,
      sender: user,
      githubEvent: null,
      content: 'hi',
      editedAt: null,
      deletedAt: null,
      createdAt: when,
      parentId: null,
      thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
      reactions: [],
      mentions: [],
      attachments: [],
    };
    expect(Value.Check(Message, message)).toBe(true);
    expect(Value.Check(Message, { ...message, sender: id })).toBe(false);
  });
});

describe("a repository's event (D-134 §6)", () => {
  const sha = 'a'.repeat(40);
  const push = {
    kind: 'push',
    repository: 'acme/api',
    actor: 'dependabot[bot]',
    ref: { type: 'branch', name: 'main' },
    change: 'pushed',
    before: sha,
    after: sha,
    commits: [{ sha, title: 'x'.repeat(GITHUB_EVENT_TEXT_MAX) }],
    commitCount: 20,
  };

  test('is bounded in every part, so nothing GitHub sends can grow a message past its shape', () => {
    expect(Value.Check(GitHubEvent, push)).toBe(true);
    // At the bounds: an enterprise's managed login, the longest ref, the most commits GitHub lists.
    expect(
      Value.Check(GitHubEvent, {
        ...push,
        actor: 'alice_acme',
        ref: { type: 'tag', name: 'r'.repeat(GIT_REF_NAME_MAX) },
        commitCount: PUSH_COMMITS_LISTED_MAX,
      }),
    ).toBe(true);
    for (const [why, wrong] of [
      [
        'a title one past the bound',
        { commits: [{ sha, title: 'x'.repeat(GITHUB_EVENT_TEXT_MAX + 1) }] },
      ],
      [
        'more commits than are shown',
        { commits: Array.from({ length: PUSH_COMMITS_SHOWN_MAX + 1 }, () => ({ sha, title: '' })) },
      ],
      ['a count past what GitHub lists', { commitCount: PUSH_COMMITS_LISTED_MAX + 1 }],
      [
        'a ref name past its bound',
        { ref: { type: 'branch', name: 'r'.repeat(GIT_REF_NAME_MAX + 1) } },
      ],
      ['a short sha', { before: 'abc' }],
      ['a repository that leaves itself', { repository: 'acme/..' }],
      ['a login that is a path', { actor: 'octo/cat' }],
      ['a change GitHub never makes', { change: 'rebased' }],
      // Parts only (D-101): an address the payload carried is not one of them.
      ['a field the contract does not name', { url: 'https://evil.test' }],
      ['a commit with more than its parts', { commits: [{ sha, title: 'x', author: 'a@b.test' }] }],
    ] as const) {
      expect({ why, valid: Value.Check(GitHubEvent, { ...push, ...wrong }) }).toEqual({
        why,
        valid: false,
      });
    }
  });

  test('a message is a person’s or an event, and says which', () => {
    const message = {
      id,
      channelId: id,
      sender: null,
      githubEvent: push,
      content: 'pushed',
      editedAt: null,
      deletedAt: null,
      createdAt: when,
      parentId: null,
      thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
      reactions: [],
      mentions: [],
      attachments: [],
    };
    expect(Value.Check(Message, message)).toBe(true);
    expect(Value.Check(Message, { ...message, githubEvent: { ...push, kind: 'deployment' } })).toBe(
      false,
    );
  });
});

describe('a GitHub link', () => {
  test('is an item on github.com, never a path that leaves its repository (#66)', () => {
    const accepted = [
      'https://github.com/acme/api/pull/42',
      'https://github.com/acme/.github/issues/1',
      'https://github.com/acme/a..b/pull/1',
    ];
    const refused = [
      'https://github.com/acme/../pull/1',
      'https://github.com/acme/./pull/1',
      `https://github.com/${'a'.repeat(40)}/api/pull/1`,
      `https://github.com/acme/${'r'.repeat(101)}/pull/1`,
      'https://github.com/acme/api/pull/12345678901',
      'https://github.com/-acme/api/pull/1',
    ];
    for (const url of accepted)
      expect({ url, ok: Value.Check(GitHubLink, url) }).toEqual({ url, ok: true });
    for (const url of refused)
      expect({ url, ok: Value.Check(GitHubLink, url) }).toEqual({ url, ok: false });
  });
});

describe('socket frames', () => {
  const send = { id, op: 'MESSAGE_SEND', payload: { channelId: id, content: 'hello' } };

  test('a send frame validates, and its id is the message id (D-8)', () => {
    expect(Value.Check(MessageSendFrame, send)).toBe(true);
    expect(Value.Check(ClientFrame, send)).toBe(true);
  });

  test('a frame may carry attachments; empty words are the service’s to judge, beside them or not', () => {
    expect(
      Value.Check(ClientFrame, {
        ...send,
        payload: { channelId: id, content: '', attachmentIds: [send.id] },
      }),
    ).toBe(true);
    expect(
      Value.Check(ClientFrame, { ...send, payload: { ...send.payload, attachmentIds: [] } }),
    ).toBe(false);
  });

  /**
   * Only the operations Phase 0 sends exist. A frame is added when the feature
   * that sends it is built, which is what keeps the exhaustiveness check
   * meaningful rather than forcing stubs.
   */
  test('an operation this phase does not serve is refused', () => {
    expect(Value.Check(ClientFrame, { ...send, op: 'THREAD_REPLY' })).toBe(false);
  });

  test('a server frame carries the clock, for drift correction only (D-8)', () => {
    const ack = { event: 'ACK', data: { id }, ts: 1_757_404_800_000, refId: id };
    expect(Value.Check(ServerFrame, ack)).toBe(true);
    expect(Value.Check(ServerFrame, { event: 'ACK', data: { id } })).toBe(false);
  });

  test('an error frame carries a code from the closed set', () => {
    const good = { event: 'ERROR', data: { code: 'CHANNEL_NOT_FOUND', message: 'no' }, ts: 1 };
    expect(Value.Check(ServerFrame, good)).toBe(true);
    expect(Value.Check(ServerFrame, { ...good, data: { code: 'MADE_UP', message: 'no' } })).toBe(
      false,
    );
  });

  test('validation failures carry their fields; other codes carry none', () => {
    expect(
      Value.Check(AppErrorBody, {
        code: 'VALIDATION_FAILED',
        message: 'bad',
        details: { fields: { slug: 'must be lowercase' } },
      }),
    ).toBe(true);
    // The details branch is reachable only through VALIDATION_FAILED.
    expect(Value.Check(AppErrorBody, { code: 'VALIDATION_FAILED', message: 'bad' })).toBe(false);
  });

  test('every error code is a literal, so a client can handle them exhaustively', () => {
    expect(ErrorCode.anyOf.length).toBeGreaterThan(10);
    for (const member of ErrorCode.anyOf) {
      expect(typeof member.const).toBe('string');
    }
  });
});

describe('http shapes', () => {
  test('a page carries its cursor, and null means the last one', () => {
    expect(Value.Check(MessagePage, { data: [], nextCursor: null })).toBe(true);
    expect(Value.Check(MessagePage, { data: [] })).toBe(false);
  });

  test('the page helper works for any item', () => {
    const page = Page(Type.String());
    expect(Value.Check(page, { data: ['a'], nextCursor: null })).toBe(true);
    expect(Value.Check(page, { data: [1], nextCursor: null })).toBe(false);
  });

  /** The client supplies the id so a retry cannot duplicate (D-8). */
  test('sending a message requires the client-generated id', () => {
    expect(Value.Check(SendMessageRequest, { id, content: 'hi' })).toBe(true);
    expect(Value.Check(SendMessageRequest, { content: 'hi' })).toBe(false);
    expect(Value.Check(SendMessageRequest, { id: 'not-a-uuid', content: 'hi' })).toBe(false);
  });

  test('a send may carry attachments: one to the most a message holds, each once; words then optional', () => {
    const ids = (n: number): string[] =>
      Array.from({ length: n }, (_, k) => messageId(new Date(Date.UTC(2026, 8, 9, 12, 0, 0, k))));
    const sends = (extra: object): boolean =>
      Value.Check(SendMessageRequest, { id, content: 'hi', ...extra });
    expect(sends({ attachmentIds: ids(1) })).toBe(true);
    expect(sends({ attachmentIds: ids(ATTACHMENTS_PER_MESSAGE_MAX) })).toBe(true);
    expect(sends({ attachmentIds: ids(ATTACHMENTS_PER_MESSAGE_MAX + 1) })).toBe(false);
    expect(sends({ attachmentIds: [] })).toBe(false);
    const one = ids(1)[0] ?? '';
    expect(sends({ attachmentIds: [one, one] })).toBe(false);
    expect(sends({ attachmentIds: ['not-a-uuid'] })).toBe(false);
    // Empty words pass the contract either way: whether something is attached beside them is the
    // service's to say, so the refusal names `content` (a union of two shapes could only say "body").
    expect(Value.Check(SendMessageRequest, { id, content: '', attachmentIds: ids(1) })).toBe(true);
    expect(Value.Check(SendMessageRequest, { id, content: '' })).toBe(true);
    // An edit still needs words.
    expect(Value.Check(EditMessageRequest, { content: '' })).toBe(false);
  });

  test('a channel is public unless asked to be private, and never a direct message', () => {
    expect(Value.Check(CreateChannelRequest, { name: 'general' })).toBe(true);
    expect(Value.Check(CreateChannelRequest, { name: 'leads', type: 'private' })).toBe(true);
    expect(Value.Check(CreateChannelRequest, { name: 'x', type: 'public' })).toBe(true);
    expect(Value.Check(CreateChannelRequest, { name: 'x', type: 'direct_message' })).toBe(false);
  });

  test('a search is at least a trigram long and bounded, and takes no forward cursor', () => {
    const at = (n: number): string => 'x'.repeat(n);
    expect(Value.Check(SearchQuery, { q: at(SEARCH_QUERY_MIN) })).toBe(true);
    expect(Value.Check(SearchQuery, { q: at(SEARCH_QUERY_MIN - 1) })).toBe(false);
    expect(Value.Check(SearchQuery, { q: at(SEARCH_QUERY_MAX) })).toBe(true);
    expect(Value.Check(SearchQuery, { q: at(SEARCH_QUERY_MAX + 1) })).toBe(false);
    expect(Value.Check(SearchQuery, { q: 'abc', after: id })).toBe(false);
    expect(Value.Check(SearchQuery, { q: 'abc\u0000' })).toBe(false);
    expect(Value.Check(SearchQuery, { q: 'abc', channelId: id, before: id, limit: 5 })).toBe(true);
  });

  test('the inbox is one workspace, a page at a time, newest first', () => {
    expect(Value.Check(NotificationQuery, { workspaceId: id })).toBe(true);
    expect(Value.Check(NotificationQuery, { workspaceId: id, unreadOnly: true, before: id })).toBe(
      true,
    );
    expect(Value.Check(NotificationQuery, {})).toBe(false);
    expect(Value.Check(NotificationQuery, { workspaceId: id, after: id })).toBe(false);
    expect(Value.Check(NotificationQuery, { workspaceId: id, limit: PAGE_LIMIT.max + 1 })).toBe(
      false,
    );
  });

  test('reading notifications names them, or a workspace up to one of them, never both', () => {
    const many = (n: number): string[] => Array.from({ length: n }, () => id);
    expect(Value.Check(ReadNotificationsRequest, { ids: [id] })).toBe(true);
    expect(Value.Check(ReadNotificationsRequest, { ids: many(PAGE_LIMIT.max) })).toBe(true);
    expect(Value.Check(ReadNotificationsRequest, { ids: many(PAGE_LIMIT.max + 1) })).toBe(false);
    expect(Value.Check(ReadNotificationsRequest, { ids: [] })).toBe(false);
    expect(Value.Check(ReadNotificationsRequest, { workspaceId: id })).toBe(true);
    expect(Value.Check(ReadNotificationsRequest, { workspaceId: id, before: id })).toBe(true);
    expect(Value.Check(ReadNotificationsRequest, { ids: [id], workspaceId: id })).toBe(false);
    expect(Value.Check(ReadNotificationsRequest, { ids: ['nope'] })).toBe(false);
  });

  test('a notification level is one of three words, for the caller alone', () => {
    for (const level of ['all', 'mentions', 'none']) {
      expect(Value.Check(SetNotificationLevelRequest, { level })).toBe(true);
    }
    expect(Value.Check(SetNotificationLevelRequest, { level: 'loud' })).toBe(false);
    expect(Value.Check(SetNotificationLevelRequest, { level: 'none', userId: id })).toBe(false);
  });

  test('Deep Work is started until an instant, or ended; never started open-ended', () => {
    const until = '2026-09-09T13:00:00.000Z';
    expect(Value.Check(SetDeepWorkRequest, { active: true, until })).toBe(true);
    expect(Value.Check(SetDeepWorkRequest, { active: false })).toBe(true);
    expect(Value.Check(SetDeepWorkRequest, { active: true })).toBe(false);
    expect(Value.Check(SetDeepWorkRequest, { active: false, until })).toBe(false);
    expect(Value.Check(SetDeepWorkRequest, { active: true, until: 'tomorrow' })).toBe(false);
  });

  test('adding to a channel names one person and nothing else', () => {
    expect(Value.Check(AddChannelMemberRequest, { userId: id })).toBe(true);
    expect(Value.Check(AddChannelMemberRequest, { userId: 'bob' })).toBe(false);
    expect(Value.Check(AddChannelMemberRequest, { userId: id, role: 'admin' })).toBe(false);
  });

  test('an edit is new content and nothing else: not the id, not a parent', () => {
    expect(Value.Check(EditMessageRequest, { content: 'fixed' })).toBe(true);
    expect(Value.Check(EditMessageRequest, { content: '' })).toBe(false);
    expect(Value.Check(EditMessageRequest, {})).toBe(false);
    expect(Value.Check(EditMessageRequest, { content: 'x', parentId: id })).toBe(false);
  });
});

/**
 * Nothing the client sends may carry a field nobody validates.
 *
 * TypeBox does not set `additionalProperties: false`, and the server framework
 * does not add it — measured, not assumed (`docs/spikes/elysia.md`): a body with
 * an extra property returns 200 and the property is silently dropped. A client
 * sending `roleOverride` would be told it worked. (D-57)
 *
 * The set of shapes checked is **derived, not listed**: the client frames come
 * out of `ClientFrame` itself, which is by definition everything the client can
 * send, and the HTTP side is matched by name. A hand-written list would be a
 * second copy that a new request shape silently escapes.
 */
describe('what the client sends refuses what it did not declare', () => {
  interface Node {
    readonly type?: string;
    readonly additionalProperties?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly items?: unknown;
    readonly anyOf?: readonly unknown[];
  }

  /** Every object anywhere inside a schema, including through arrays and unions. */
  const objectsIn = (schema: unknown, path: string): (readonly [string, Node])[] => {
    if (typeof schema !== 'object' || schema === null) return [];
    const node = schema as Node;
    const found: (readonly [string, Node])[] = [];
    if (node.type === 'object') found.push([path, node]);
    for (const [key, value] of Object.entries(node.properties ?? {})) {
      found.push(...objectsIn(value, `${path}.${key}`));
    }
    if (node.items !== undefined) found.push(...objectsIn(node.items, `${path}[]`));
    for (const [index, member] of (node.anyOf ?? []).entries()) {
      found.push(...objectsIn(member, `${path}|${String(index)}`));
    }
    return found;
  };

  const sent: (readonly [string, unknown])[] = [
    // Derived: the union *is* the set of frames a client may send.
    ...ClientFrame.anyOf.map((frame, index) => [`ClientFrame|${String(index)}`, frame] as const),
    ...Object.entries(api).filter(([name]) => /(?:Request|Query)$/.test(name)),
  ];

  test('there are shapes to check, and they contain objects', () => {
    expect(sent.length).toBeGreaterThan(5);
    expect(sent.flatMap(([name, schema]) => objectsIn(schema, name)).length).toBeGreaterThan(
      sent.length,
    );
  });

  for (const [name, schema] of sent) {
    test(`${name} and everything inside it refuses unknown properties`, () => {
      const open = objectsIn(schema, name)
        .filter(([, node]) => node.additionalProperties !== false)
        .map(([where]) => where);
      expect(open).toEqual([]);
    });
  }

  test('and it actually rejects one at runtime', () => {
    expect(Value.Check(SendMessageRequest, { id, content: 'hi' })).toBe(true);
    expect(Value.Check(SendMessageRequest, { id, content: 'hi', roleOverride: 'owner' })).toBe(
      false,
    );
  });

  /** A response may gain a field without breaking a client that has not rebuilt. */
  test('a response is not closed, deliberately', () => {
    expect(MeResponse.additionalProperties).toBeUndefined();
  });
});

describe('the wedge: threads, reactions, read state (D-98)', () => {
  const root = {
    id,
    channelId: id,
    sender: user,
    githubEvent: null,
    content: 'why is the backoff 4s?',
    editedAt: null,
    deletedAt: null,
    createdAt: when,
    parentId: null,
    thread: { replyCount: 2, lastReplyAt: when, resolvedAt: when, resolvedBy: user },
    reactions: [{ emoji: '👍', userIds: [id] }],
    mentions: [id],
    attachments: [],
  };

  test('a window around a message names it and carries both cursors, null at an end (D-149)', () => {
    const window = { target: root, data: [root], olderCursor: id, newerCursor: null };
    expect(Value.Check(MessageWindow, window)).toBe(true);
    expect(Value.Check(MessageWindow, { ...window, target: null })).toBe(false);
    expect(Value.Check(MessageWindow, { data: [root], olderCursor: null, newerCursor: null })).toBe(
      false,
    );
    expect(Value.Check(MessageWindow, { target: root, data: [root], olderCursor: null })).toBe(
      false,
    );
  });

  test('a root carries its thread summary, a reply carries none', () => {
    expect(Value.Check(Message, root)).toBe(true);
    expect(Value.Check(Message, { ...root, parentId: id, thread: null })).toBe(true);
    expect(Value.Check(Message, { ...root, thread: undefined })).toBe(false);
  });

  test('a reaction is one emoji, and somebody; an empty set of people is not a reaction', () => {
    expect(Value.Check(Message, { ...root, reactions: [{ emoji: '👍', userIds: [] }] })).toBe(
      false,
    );
    expect(
      Value.Check(Message, { ...root, reactions: [{ emoji: 'thumbs up', userIds: [id] }] }),
    ).toBe(false);
  });

  test.each(['👍', '🎉', '👍🏽', '👨‍👩‍👧', '🇹🇷', '1️⃣', '❤️'])('%s is an emoji', (emoji) => {
    expect(Value.Check(ReactionsResponse, { reactions: [{ emoji, userIds: [id] }] })).toBe(true);
  });

  test.each(['', 'a', 'ab', '👍👍', '👍 ', '<script>', '1', '🏽'])(
    '%j is not one emoji',
    (emoji) => {
      expect(Value.Check(ReactionsResponse, { reactions: [{ emoji, userIds: [id] }] })).toBe(false);
    },
  );

  test('a reply is sent with the root it answers; the field is optional and closed', () => {
    expect(Value.Check(SendMessageRequest, { id, content: 'a', parentId: id })).toBe(true);
    expect(Value.Check(SendMessageRequest, { id, content: 'a', parentId: 'x' })).toBe(false);
    expect(Value.Check(SendMessageRequest, { id, content: 'a', resolved: true })).toBe(false);
    const frame = {
      id,
      op: 'MESSAGE_SEND',
      payload: { channelId: id, content: 'a', parentId: id },
    };
    expect(Value.Check(ClientFrame, frame)).toBe(true);
  });

  test('threads and open questions are keyset pages of messages', () => {
    expect(Value.Check(ThreadPage, { data: [root], nextCursor: null })).toBe(true);
    expect(Value.Check(UnresolvedPage, { data: [root], nextCursor: id })).toBe(true);
  });

  test('reading names a message and nothing else', () => {
    expect(Value.Check(ReadChannelRequest, { lastReadMessageId: id })).toBe(true);
    expect(Value.Check(ReadChannelRequest, { lastReadMessageId: id, unreadCount: 0 })).toBe(false);
    expect(Value.Check(ReadThreadRequest, { lastReadMessageId: id })).toBe(true);
    expect(Value.Check(ReadThreadRequest, {})).toBe(false);
    expect(Value.Check(CreateDirectMessageRequest, { userId: id })).toBe(true);
  });

  test('a revision carries what an edit or a delete changes, and nothing it does not', () => {
    const revision = {
      event: 'MESSAGE_REVISED',
      data: {
        channelId: id,
        messageId: id,
        parentId: null,
        content: '',
        editedAt: null,
        deletedAt: when,
        mentions: [],
      },
      version: 3,
      ts: 1,
    };
    expect(Value.Check(ServerFrame, revision)).toBe(true);
    // Reactions have their own frame and their own version: a late revision must not carry them.
    expect(
      Value.Check(ServerFrame, { ...revision, data: { ...revision.data, reactions: [] } }),
    ).toBe(false);
    expect(Value.Check(ServerFrame, { ...revision, version: 0 })).toBe(false);
  });

  test('the new frames validate, and each carries what it must', () => {
    const state = { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 1 };
    const frames = [
      {
        event: 'THREAD_UPDATED',
        data: { channelId: id, messageId: id, thread: root.thread },
        version: 1,
        ts: 1,
      },
      {
        event: 'REACTIONS_UPDATED',
        data: { channelId: id, messageId: id, reactions: root.reactions },
        version: 1,
        ts: 1,
      },
      { event: 'CHANNEL_STATE', data: { channelId: id, state }, version: 1, ts: 1 },
      {
        event: 'MESSAGE_REVISED',
        data: {
          channelId: id,
          messageId: id,
          parentId: null,
          content: 'better words',
          editedAt: when,
          deletedAt: null,
          mentions: [id],
        },
        version: 2,
        ts: 1,
      },
      {
        event: 'CHANNEL_ADDED',
        data: {
          id,
          workspaceId: id,
          name: null,
          topic: null,
          type: 'direct_message',
          lastMessageAt: null,
          state,
          notificationLevel: 'mentions',
          starred: false,
          incident: null,
          peer: user,
          peers: [user],
        },
        ts: 1,
      },
    ];
    for (const frame of frames) expect(Value.Check(ServerFrame, frame)).toBe(true);
    expect(
      Value.Check(ServerFrame, {
        ...frames[2],
        data: { channelId: id, state: { ...state, unreadCount: -1 } },
      }),
    ).toBe(false);
  });

  // The order a whole state was written in is not optional: a frame without it could not be
  // compared with the one before, which is the whole reason it is there (0015).
  test('a whole-state frame names its version, and a version is a positive whole number', () => {
    const state = { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 };
    const frame = { event: 'CHANNEL_STATE', data: { channelId: id, state }, ts: 1 };
    expect(Value.Check(ServerFrame, frame)).toBe(false);
    expect(Value.Check(ServerFrame, { ...frame, version: 0 })).toBe(false);
    expect(Value.Check(ServerFrame, { ...frame, version: 1.5 })).toBe(false);
    expect(Value.Check(ServerFrame, { ...frame, version: 2 })).toBe(true);
  });
});
