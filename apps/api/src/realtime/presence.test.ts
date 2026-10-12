import { describe, expect, test } from 'bun:test';
import { aMovableClock } from '../testing/doubles';
import { inMemoryPresenceRegistry } from './presence';

const channel = '0190a000-0000-7000-8000-000000000001';
const other = '0190a000-0000-7000-8000-000000000002';
const ana = '0190a000-0000-7000-8000-00000000000a';
const ben = '0190a000-0000-7000-8000-00000000000b';
const TTL = 6_000;

describe('inMemoryPresenceRegistry: typing', () => {
  test('the first announcement is heard, and a repeat inside half the window is not', () => {
    const clock = aMovableClock();
    const registry = inMemoryPresenceRegistry(clock);
    expect(registry.startTyping(channel, ana, TTL)).toBe(true);
    clock.advance(TTL / 2 - 1);
    expect(registry.startTyping(channel, ana, TTL)).toBe(false);
  });

  test('once half the window is spent the room hears it again, so listeners never run out', () => {
    const clock = aMovableClock();
    const registry = inMemoryPresenceRegistry(clock);
    registry.startTyping(channel, ana, TTL);
    clock.advance(TTL / 2);
    expect(registry.startTyping(channel, ana, TTL)).toBe(true);
    // And the window restarted from that announcement, not the first.
    clock.advance(TTL / 2 - 1);
    expect(registry.startTyping(channel, ana, TTL)).toBe(false);
  });

  test('each person and each channel has a window of its own', () => {
    const registry = inMemoryPresenceRegistry(aMovableClock());
    expect(registry.startTyping(channel, ana, TTL)).toBe(true);
    expect(registry.startTyping(channel, ben, TTL)).toBe(true);
    expect(registry.startTyping(other, ana, TTL)).toBe(true);
  });

  test('stopTyping ends a window at once: the next announcement is heard', () => {
    const registry = inMemoryPresenceRegistry(aMovableClock());
    registry.startTyping(channel, ana, TTL);
    registry.stopTyping(channel, ana);
    expect(registry.startTyping(channel, ana, TTL)).toBe(true);
  });

  test('what ran out is let go, so a channel typed in once is not held forever', () => {
    const clock = aMovableClock();
    const registry = inMemoryPresenceRegistry(clock);
    registry.startTyping(channel, ana, TTL);
    registry.startTyping(other, ben, TTL);
    expect(registry.held()).toBe(2);
    clock.advance(TTL);
    // Any later call sweeps what has expired, wherever it was.
    registry.startTyping(channel, ben, TTL);
    expect(registry.held()).toBe(1);
    registry.stopTyping(channel, ben);
    expect(registry.held()).toBe(0);
  });
});
