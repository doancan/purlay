/**
 * When the server's lifetime policy ends a session (D-244), as arithmetic: the boundaries to the millisecond,
 * each rule alone and both together, and that neither rule on ends nothing whatever the session's age.
 */
import { describe, expect, test } from 'bun:test';
import { SESSION_IDLE_TIMEOUT_HOURS, SESSION_MAX_AGE_DAYS } from '@purlay/types';
import { fixedEnd, lapsed, lifetimeLimited, NO_SESSION_LIFETIME } from './session-lifetime';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-11-01T12:00:00.000Z');
const before = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('lapsed', () => {
  test('off: a session signed in and last used years ago is not ended by the policy', () => {
    expect(lifetimeLimited(NO_SESSION_LIFETIME)).toBe(false);
    expect(
      lapsed(
        NO_SESSION_LIFETIME,
        { createdAt: before(900 * DAY), lastUsedAt: before(900 * DAY) },
        NOW,
      ),
    ).toBe(false);
  });

  test('the idle timeout ends a session at the instant it has gone unused that long, and not a millisecond sooner', () => {
    for (const hours of SESSION_IDLE_TIMEOUT_HOURS) {
      const lifetime = { sessionIdleTimeoutHours: hours, sessionMaxAgeDays: null };
      const fresh = before(hours * HOUR - 1);
      const due = before(hours * HOUR);
      expect([
        hours,
        lapsed(lifetime, { createdAt: before(DAY * 365), lastUsedAt: fresh }, NOW),
      ]).toEqual([hours, false]);
      expect([hours, lapsed(lifetime, { createdAt: fresh, lastUsedAt: due }, NOW)]).toEqual([
        hours,
        true,
      ]);
    }
  });

  test('the maximum age ends a session at the instant it is that old, however recently it was used', () => {
    for (const days of SESSION_MAX_AGE_DAYS) {
      const lifetime = { sessionIdleTimeoutHours: null, sessionMaxAgeDays: days };
      expect([
        days,
        lapsed(lifetime, { createdAt: before(days * DAY - 1), lastUsedAt: NOW }, NOW),
      ]).toEqual([days, false]);
      expect([
        days,
        lapsed(lifetime, { createdAt: before(days * DAY), lastUsedAt: NOW }, NOW),
      ]).toEqual([days, true]);
    }
  });

  test('with both on, either one ends it', () => {
    const lifetime = { sessionIdleTimeoutHours: 8, sessionMaxAgeDays: 7 } as const;
    expect(lapsed(lifetime, { createdAt: before(DAY), lastUsedAt: before(HOUR) }, NOW)).toBe(false);
    expect(lapsed(lifetime, { createdAt: before(DAY), lastUsedAt: before(9 * HOUR) }, NOW)).toBe(
      true,
    );
    expect(lapsed(lifetime, { createdAt: before(8 * DAY), lastUsedAt: NOW }, NOW)).toBe(true);
  });
});

describe('fixedEnd', () => {
  const createdAt = before(DAY);
  const expiresAt = new Date(createdAt.getTime() + 30 * DAY);

  test('is the session’s own expiry without a maximum age, and with one that is later', () => {
    expect(fixedEnd(NO_SESSION_LIFETIME, { createdAt, expiresAt })).toEqual(expiresAt);
    expect(
      fixedEnd({ sessionIdleTimeoutHours: 1, sessionMaxAgeDays: null }, { createdAt, expiresAt }),
    ).toEqual(expiresAt);
    expect(
      fixedEnd({ sessionIdleTimeoutHours: null, sessionMaxAgeDays: 90 }, { createdAt, expiresAt }),
    ).toEqual(expiresAt);
  });

  test('is the maximum age where that is sooner', () => {
    expect(
      fixedEnd({ sessionIdleTimeoutHours: null, sessionMaxAgeDays: 7 }, { createdAt, expiresAt }),
    ).toEqual(new Date(createdAt.getTime() + 7 * DAY));
  });
});
