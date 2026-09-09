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
import { MessagePage, Page, SendMessageRequest } from './api';
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
