/**
 * The length limit fits the frame cap — proven over every code unit, not argued.
 *
 * Three numbers meet here: `MESSAGE_CONTENT_MAX`, `MAX_FRAME_BYTES`, and what JSON
 * makes of one code unit. If they disagree, a message the contract accepts ends
 * the sender's connection, the client resends it on reconnect, and the two loop
 * (D-67). So the third number is measured for all 65,536 code units rather than
 * taken from a table, and the worst case is built and weighed as a real frame.
 */
import { describe, expect, test } from 'bun:test';
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import './formats';
import { MAX_FRAME_BYTES, MessageSendFrame } from './events';
import { messageId } from './message-id';
import { ATTACHMENTS_PER_MESSAGE_MAX, MESSAGE_CONTENT_MAX, MessageContent } from './models';

const isContent = (value: string): boolean =>
  FormatRegistry.Get('message-content')?.(value) ?? false;

/** Bytes a string costs inside a JSON document, without its quotes. */
const wireBytes = (value: string): number => Buffer.byteLength(JSON.stringify(value), 'utf8') - 2;

/** The most any accepted code unit costs on the wire. */
const WORST_BYTES_PER_UNIT = 3;

describe('message content', () => {
  test('no accepted code unit costs more than three bytes in JSON', () => {
    let accepted = 0;
    let worst = 0;
    for (let unit = 0; unit <= 0xffff; unit += 1) {
      const character = String.fromCharCode(unit);
      if (!isContent(character)) continue;
      accepted += 1;
      worst = Math.max(worst, wireBytes(character));
    }
    // A check that accepted nothing would make the bound vacuous.
    expect(accepted).toBeGreaterThan(60_000);
    expect(worst).toBe(WORST_BYTES_PER_UNIT);
  });

  test('a surrogate pair is accepted and costs two bytes a unit; either half alone is not', () => {
    const emoji = '\u{1F600}';
    expect(emoji).toHaveLength(2);
    expect(isContent(emoji)).toBe(true);
    expect(wireBytes(emoji)).toBe(4);
    expect(isContent('\uD83D')).toBe(false);
    expect(isContent('\uDE00')).toBe(false);
    expect(isContent(`a\uDE00\uD83Db`)).toBe(false);
  });

  test('the whitespace people actually paste is accepted; other controls are not', () => {
    expect(isContent('line\n\tindented\r\n')).toBe(true);
    for (const control of ['\u0000', '\u0007', '\u000B', '\u001B', '\u001F']) {
      expect({ control, accepted: isContent(`x${control}y`) }).toEqual({
        control,
        accepted: false,
      });
    }
  });

  test('the length limit is exact, in code units', () => {
    expect(Value.Check(MessageContent, 'x'.repeat(MESSAGE_CONTENT_MAX))).toBe(true);
    expect(Value.Check(MessageContent, 'x'.repeat(MESSAGE_CONTENT_MAX + 1))).toBe(false);
    expect(Value.Check(MessageContent, '')).toBe(false);
  });

  test('the longest, most expensive message fits one frame, envelope included', () => {
    // U+0800 is the first code unit UTF-8 spends three bytes on.
    const worst = 'ࠀ'.repeat(MESSAGE_CONTENT_MAX);
    const at = (n: number): string => messageId(new Date(Date.UTC(2026, 8, 9, 12, 0, 0, n)));
    const frame = {
      id: at(0),
      op: 'MESSAGE_SEND',
      payload: {
        channelId: '00000000-0000-4000-8000-000000000000',
        content: worst,
        // As many attachments as a message may carry (D-109 §7).
        attachmentIds: Array.from({ length: ATTACHMENTS_PER_MESSAGE_MAX }, (_, n) => at(n + 1)),
      },
    };
    expect(Value.Check(MessageSendFrame, frame)).toBe(true);

    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8');
    expect(bytes).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    // And the margin is not an accident of today's envelope: the content alone
    // leaves room for one many times larger than the one we send.
    expect(MAX_FRAME_BYTES - MESSAGE_CONTENT_MAX * WORST_BYTES_PER_UNIT).toBeGreaterThan(4_096);
  });
});
