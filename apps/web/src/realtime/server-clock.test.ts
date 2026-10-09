/**
 * Drift correction (D-33): ids are generated against the server's clock, so two
 * laptops whose clocks disagree still interleave in real-time order.
 */
import { describe, expect, test } from 'bun:test';
import { isPlausibleMessageId, messageId, messageIdTime } from '@purlay/types';
import type { Clock } from './clock';
import { createServerClock } from './server-clock';

/** A clock a test moves by hand, so time passes without waiting for it. */
const manualClock = (start: Date): Clock & { advance: (milliseconds: number) => void } => {
  let current = start.getTime();
  return {
    now: (): Date => new Date(current),
    advance: (milliseconds: number): void => {
      current += milliseconds;
    },
  };
};

const START = new Date('2026-10-09T12:00:00.000Z');

describe('the server clock', () => {
  test('before any PONG it is the local clock, and says it is not corrected', () => {
    const local = manualClock(START);
    const clock = createServerClock(local);
    expect(clock.corrected()).toBe(false);
    expect(clock.now().getTime()).toBe(START.getTime());
  });

  test('a PONG sets the offset, so a slow laptop reads server time', () => {
    const local = manualClock(START);
    const clock = createServerClock(local);
    // The server is 40 s ahead of this machine; the round trip took 100 ms, so
    // the server stamped the PONG at the midpoint, 50 ms after the PING left.
    const sentAt = local.now();
    local.advance(100);
    clock.observe({ sentAt, receivedAt: local.now(), serverTs: START.getTime() + 40_000 + 50 });

    expect(clock.corrected()).toBe(true);
    expect(clock.now().getTime()).toBe(local.now().getTime() + 40_000);
  });

  test('the correction keeps up with the local clock rather than freezing at the sample', () => {
    const local = manualClock(START);
    const clock = createServerClock(local);
    clock.observe({ sentAt: START, receivedAt: START, serverTs: START.getTime() - 3_000 });
    local.advance(10_000);
    expect(clock.now().getTime()).toBe(START.getTime() + 10_000 - 3_000);
  });

  test('only the first PONG sets the offset', () => {
    const local = manualClock(START);
    const clock = createServerClock(local);
    clock.observe({ sentAt: START, receivedAt: START, serverTs: START.getTime() + 1_000 });
    clock.observe({ sentAt: START, receivedAt: START, serverTs: START.getTime() + 9_000 });
    expect(clock.now().getTime()).toBe(START.getTime() + 1_000);
  });

  test('a PONG that claims to have arrived before it was sent is refused, not trusted', () => {
    const local = manualClock(START);
    const clock = createServerClock(local);
    const later = new Date(START.getTime() + 500);
    expect(() => {
      clock.observe({ sentAt: later, receivedAt: START, serverTs: START.getTime() });
    }).toThrow();
    expect(clock.corrected()).toBe(false);
  });

  test('an id made on a skewed machine is plausible to the server only once corrected', () => {
    // This laptop is 90 s behind the server: past the 60 s the server tolerates.
    const serverNow = START;
    const local = manualClock(new Date(START.getTime() - 90_000));
    const clock = createServerClock(local);

    expect(isPlausibleMessageId(messageId(clock.now()), serverNow)).toBe(false);

    clock.observe({ sentAt: local.now(), receivedAt: local.now(), serverTs: serverNow.getTime() });
    const id = messageId(clock.now());
    expect(isPlausibleMessageId(id, serverNow)).toBe(true);
    expect(messageIdTime(id)).toBe(serverNow.getTime());
  });
});
