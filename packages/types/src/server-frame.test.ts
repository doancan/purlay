import { describe, expect, test } from 'bun:test';
import { messageId, parseServerMessage, type ServerFrame } from './index';

const id = messageId(new Date('2026-10-09T12:00:00.000Z'));

describe('parseServerMessage', () => {
  test('ERROR keeps an optional validated workspace hint without requiring one from older readers', () => {
    const frame = {
      event: 'ERROR',
      data: { code: 'WORKSPACE_ACCESS_REQUIRED', message: 'Verify first.' },
      ts: 1,
    } satisfies ServerFrame;
    const workspaceId = '00000000-0000-4000-8000-0000000000a1';
    expect(parseServerMessage(JSON.stringify(frame)).kind).toBe('frame');
    expect(parseServerMessage(JSON.stringify({ ...frame, workspaceId }))).toEqual({
      kind: 'frame',
      frame: { ...frame, workspaceId },
    });
    for (const hint of ['another/slug', null, 42]) {
      expect(parseServerMessage(JSON.stringify({ ...frame, workspaceId: hint })).kind).toBe(
        'malformed',
      );
    }
  });
  test('a frame the contract defines is a frame', () => {
    const message = parseServerMessage(JSON.stringify({ event: 'PONG', data: {}, ts: 1 }));
    expect(message.kind === 'frame' && message.frame.event).toBe('PONG');
  });

  test('an ACK keeps its correlation id', () => {
    const text = JSON.stringify({ event: 'ACK', data: { id }, ts: 1, refId: id });
    const message = parseServerMessage(text);
    expect(message.kind === 'frame' && message.frame.refId).toBe(id);
  });

  test.each([
    ['an ordinary new event', 'TYPING_STARTED'],
    ['a name only Object.prototype knows', 'toString'],
    ['a name that differs from a known one only in case', 'pong'],
  ])('%s is unknown, not malformed', (_name, event) => {
    const text = JSON.stringify({ event, data: { anything: 1 }, ts: 1 });
    expect(parseServerMessage(text)).toEqual({ kind: 'unknown', event });
  });

  test.each([
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '42'],
    ['null', 'null'],
    ['an array', '[]'],
    ['an object with no event', JSON.stringify({ data: {}, ts: 1 })],
    ['an event that is not a string', JSON.stringify({ event: 5, data: {}, ts: 1 })],
    [
      'a defined event with the wrong data',
      JSON.stringify({ event: 'ACK', data: { id: 5 }, ts: 1 }),
    ],
    ['a defined event with no server clock', JSON.stringify({ event: 'PONG', data: {} })],
  ])('%s is malformed, never mistaken for an unknown event', (_name, text) => {
    expect(parseServerMessage(text)).toEqual({ kind: 'malformed' });
  });
});
