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
import { Channel, CurrentUser, Message, User } from './models';
import { ClientFrame, MessageSendFrame, ServerFrame } from './events';
import {
  CreateDirectMessageRequest,
  MeResponse,
  MessagePage,
  Page,
  ReactionsResponse,
  ReadChannelRequest,
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
      peer: user,
    };
    expect(Value.Check(Channel, dm)).toBe(true);
    expect(Value.Check(Channel, { ...dm, type: 'nonsense' })).toBe(false);
  });

  test('a message carries its sender, not a sender id to resolve later', () => {
    const message = {
      id,
      channelId: id,
      sender: user,
      content: 'hi',
      editedAt: null,
      deletedAt: null,
      createdAt: when,
      parentId: null,
      thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
      reactions: [],
      mentions: [],
    };
    expect(Value.Check(Message, message)).toBe(true);
    expect(Value.Check(Message, { ...message, sender: id })).toBe(false);
  });
});

describe('socket frames', () => {
  const send = { id, op: 'MESSAGE_SEND', payload: { channelId: id, content: 'hello' } };

  test('a send frame validates, and its id is the message id (D-8)', () => {
    expect(Value.Check(MessageSendFrame, send)).toBe(true);
    expect(Value.Check(ClientFrame, send)).toBe(true);
  });

  test('an empty message is refused before it reaches a service', () => {
    expect(Value.Check(ClientFrame, { ...send, payload: { channelId: id, content: '' } })).toBe(
      false,
    );
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
    content: 'why is the backoff 4s?',
    editedAt: null,
    deletedAt: null,
    createdAt: when,
    parentId: null,
    thread: { replyCount: 2, lastReplyAt: when, resolvedAt: when, resolvedBy: user },
    reactions: [{ emoji: '👍', userIds: [id] }],
    mentions: [id],
  };

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
    expect(Value.Check(CreateDirectMessageRequest, { userId: id })).toBe(true);
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
        event: 'CHANNEL_ADDED',
        data: {
          id,
          workspaceId: id,
          name: null,
          topic: null,
          type: 'direct_message',
          lastMessageAt: null,
          state,
          peer: user,
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
