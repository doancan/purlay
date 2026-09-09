/**
 * The generator and the rule, bound to each other.
 *
 * They are two halves of one fact — the client makes ids the server must accept —
 * so the first test is the round trip. Without it, a window could widen on one
 * side and not the other and nothing would say so until a real message was
 * refused.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from './models';
import {
  MESSAGE_ID_SKEW,
  isMessageIdShape,
  isPlausibleMessageId,
  messageId,
  messageIdTime,
} from './message-id';

const NOW = new Date('2026-09-09T12:00:00.000Z');

describe('a generated id', () => {
  test('satisfies the rule that validates it — the binding between the two halves', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = messageId(NOW);
      expect(isMessageIdShape(id)).toBe(true);
      expect(isPlausibleMessageId(id, NOW)).toBe(true);
      // And it is a UUID by the contract's own format, not only by this file's.
      expect(Value.Check(Uuid, id)).toBe(true);
    }
  });

  test('carries the instant it was made for', () => {
    expect(messageIdTime(messageId(NOW))).toBe(NOW.getTime());
  });

  /** It is the primary key and the pagination cursor; a collision is permanent. */
  test('two ids for the same millisecond differ', () => {
    const ids = new Set(Array.from({ length: 500 }, () => messageId(NOW)));
    expect(ids.size).toBe(500);
  });

  /** Keyset pagination orders on the id alone, so time must order lexically. */
  test('a later id sorts after an earlier one, as bytes', () => {
    const earlier = messageId(NOW);
    const later = messageId(new Date(NOW.getTime() + 1));
    expect(earlier < later).toBe(true);
  });
});

describe('the rule', () => {
  test('refuses a version that is not 7 — a v4 makes a channel ordered wrongly, forever', () => {
    // Same string, version nibble changed from 7 to 4.
    const v7 = messageId(NOW);
    const v4 = `${v7.slice(0, 14)}4${v7.slice(15)}`;
    expect(isMessageIdShape(v7)).toBe(true);
    expect(isMessageIdShape(v4)).toBe(false);
    // The contract's `uuid` format accepts both, which is exactly why this exists.
    expect(Value.Check(Uuid, v4)).toBe(true);
  });

  test('refuses non-conformant variant bits', () => {
    const id = messageId(NOW);
    const bad = `${id.slice(0, 19)}c${id.slice(20)}`;
    expect(isMessageIdShape(bad)).toBe(false);
  });

  test('refuses anything that is not a uuid at all', () => {
    for (const value of ['', 'not-a-uuid', '0199155c6200-7b7f-8c11-2a4d3f9e1b70']) {
      expect(isMessageIdShape(value)).toBe(false);
      expect(isPlausibleMessageId(value, NOW)).toBe(false);
    }
  });

  /**
   * An id from the future pins itself above every message that follows **and**
   * breaks keyset pagination for every reader, because `id < cursor` then skips
   * real rows (D-33).
   */
  test('the window is generous behind and tight ahead', () => {
    const at = (offset: number): string => messageId(new Date(NOW.getTime() + offset));

    expect(isPlausibleMessageId(at(-MESSAGE_ID_SKEW.behindMs + 1000), NOW)).toBe(true);
    expect(isPlausibleMessageId(at(-MESSAGE_ID_SKEW.behindMs - 1000), NOW)).toBe(false);

    expect(isPlausibleMessageId(at(MESSAGE_ID_SKEW.aheadMs - 1000), NOW)).toBe(true);
    expect(isPlausibleMessageId(at(MESSAGE_ID_SKEW.aheadMs + 1000), NOW)).toBe(false);

    // A year in the future is the case that motivated the rule.
    expect(isPlausibleMessageId(at(365 * 24 * 60 * 60 * 1000), NOW)).toBe(false);
  });

  /**
   * The tests above compute their offsets *from* the constant, so they move with
   * it: widening the window from five seconds to sixty passed every one of them.
   * A test that reads the value it is testing cannot catch a change to that
   * value. The numbers D-33 specifies are asserted literally, and
   * `scripts/enforcement.test.ts` binds them to the decision itself.
   */
  test('the window is the one D-33 names, in the numbers it names', () => {
    expect(MESSAGE_ID_SKEW.behindMs).toBe(60_000);
    expect(MESSAGE_ID_SKEW.aheadMs).toBe(5_000);
  });

  test('the window is exactly the one the constant declares, at both edges', () => {
    const at = (offset: number): string => messageId(new Date(NOW.getTime() + offset));
    expect(isPlausibleMessageId(at(-MESSAGE_ID_SKEW.behindMs), NOW)).toBe(true);
    expect(isPlausibleMessageId(at(-MESSAGE_ID_SKEW.behindMs - 1), NOW)).toBe(false);
    expect(isPlausibleMessageId(at(MESSAGE_ID_SKEW.aheadMs), NOW)).toBe(true);
    expect(isPlausibleMessageId(at(MESSAGE_ID_SKEW.aheadMs + 1), NOW)).toBe(false);
  });
});
