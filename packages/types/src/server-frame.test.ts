import { describe, expect, test } from 'bun:test';
import { messageId, parseServerFrame } from './index';

const id = messageId(new Date('2026-10-09T12:00:00.000Z'));

describe('parseServerFrame', () => {
  test('accepts a frame the contract defines', () => {
    const frame = parseServerFrame(JSON.stringify({ event: 'PONG', data: {}, ts: 1 }));
    expect(frame?.event).toBe('PONG');
  });

  test('accepts an ACK and keeps its correlation id', () => {
    const text = JSON.stringify({ event: 'ACK', data: { id }, ts: 1, refId: id });
    expect(parseServerFrame(text)?.refId).toBe(id);
  });

  test.each([
    ['text that is not JSON', 'not json'],
    ['JSON that is not an object', '42'],
    ['an event the contract does not define', JSON.stringify({ event: 'NOPE', data: {}, ts: 1 })],
    [
      'a defined event with the wrong data',
      JSON.stringify({ event: 'ACK', data: { id: 5 }, ts: 1 }),
    ],
    ['a frame with no server clock', JSON.stringify({ event: 'PONG', data: {} })],
  ])('refuses %s', (_name, text) => {
    expect(parseServerFrame(text)).toBeNull();
  });
});
