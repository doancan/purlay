import { describe, expect, test } from 'bun:test';
import { messageId, parseServerMessage } from './index';

const id = messageId(new Date('2026-10-09T12:00:00.000Z'));

describe('parseServerMessage', () => {
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
