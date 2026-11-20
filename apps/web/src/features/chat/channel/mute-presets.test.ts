/**
 * The whiles a channel is muted for (D-329): spans from now, and "until tomorrow" on the viewer's own
 * wall clock — Deep Work's morning — inside the server's bound.
 */
import { describe, expect, test } from 'bun:test';
import { DEEP_WORK_MAX_HOURS } from '@purlay/types';
import { createFormatters } from '../../../i18n/format';
import { MUTE_CHOICES, muteEnd } from './mute-presets';

const HOUR_MS = 3_600_000;
const zone = (name: string): ReturnType<typeof createFormatters> => createFormatters('en', name);

describe('the end of a mute', () => {
  test('a span is that long from now', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    const utc = zone('UTC');
    expect(muteEnd('15m', now, utc)).toBe('2026-11-20T10:15:00.000Z');
    expect(muteEnd('1h', now, utc)).toBe('2026-11-20T11:00:00.000Z');
    expect(muteEnd('8h', now, utc)).toBe('2026-11-20T18:00:00.000Z');
  });

  test('24 hours is kept just inside the server’s bound, never past it', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    const end = new Date(muteEnd('24h', now, zone('UTC'))).getTime();
    expect(end).toBeLessThanOrEqual(now.getTime() + DEEP_WORK_MAX_HOURS * HOUR_MS);
    expect(end).toBeGreaterThan(now.getTime() + 23.9 * HOUR_MS);
  });

  test('until tomorrow is nine the next morning on the viewer’s clock, whatever the zone', () => {
    // 13:00 in Istanbul (UTC+3): tomorrow at 09:00 there is 06:00 UTC.
    const now = new Date('2026-11-20T10:00:00.000Z');
    expect(muteEnd('tomorrow', now, zone('Europe/Istanbul'))).toBe('2026-11-21T06:00:00.000Z');
    // 13:00 in New York (UTC-5) is 18:00 UTC: its nine tomorrow is 14:00 UTC on the 21st.
    const later = new Date('2026-11-20T18:00:00.000Z');
    expect(muteEnd('tomorrow', later, zone('America/New_York'))).toBe('2026-11-21T14:00:00.000Z');
  });

  test('in the small hours, until tomorrow is this coming morning', () => {
    // 01:30 in Istanbul on the 21st: the night is not over, so 09:00 the same day.
    const now = new Date('2026-11-20T22:30:00.000Z');
    expect(muteEnd('tomorrow', now, zone('Europe/Istanbul'))).toBe('2026-11-21T06:00:00.000Z');
  });

  test('a morning further than the bound is the bound', () => {
    // 05:30 in Istanbul: tomorrow at nine is 27.5 hours away, past the 24 the server allows.
    const now = new Date('2026-11-20T02:30:00.000Z');
    const end = new Date(muteEnd('tomorrow', now, zone('Europe/Istanbul'))).getTime();
    expect(end).toBeLessThanOrEqual(now.getTime() + DEEP_WORK_MAX_HOURS * HOUR_MS);
    expect(end).toBeGreaterThan(now.getTime() + 23.9 * HOUR_MS);
  });

  test('every choice ends ahead of now and inside the bound', () => {
    const now = new Date('2026-03-29T00:30:00.000Z');
    for (const name of ['UTC', 'Europe/Istanbul', 'Europe/London', 'Pacific/Auckland']) {
      for (const choice of MUTE_CHOICES) {
        const end = new Date(muteEnd(choice, now, zone(name))).getTime();
        expect(end).toBeGreaterThan(now.getTime());
        expect(end).toBeLessThanOrEqual(now.getTime() + DEEP_WORK_MAX_HOURS * HOUR_MS);
      }
    }
  });
});
