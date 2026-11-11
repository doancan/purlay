/** Calendar choices must survive real device time zones without normalization into another day or DST hour. */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { guestExpiryInstant } from './guest-expiry';

describe('guest access end choices', () => {
  test('incomplete, impossible and malformed calendar/time values are not a choice', () => {
    for (const [day, time] of [
      ['', '12:00'],
      ['2026-02-29', '12:00'],
      ['2026-04-31', '12:00'],
      ['2026-13-01', '12:00'],
      ['2026-11-10', ''],
      ['2026-11-10', '24:00'],
      ['2026-11-10', '12:60'],
      ['2026-11-10', '午後'],
      ['2026-11-10Z', '12:00'],
    ])
      expect(guestExpiryInstant(day ?? '', time ?? '')).toBeNull();
    expect(guestExpiryInstant('2028-02-29', '12:00')).not.toBeNull();
  });

  test.each([
    ['UTC', '2026-11-10T15:30:00.000Z', '2026-12-31', '22:15'],
    ['Europe/Istanbul', '2026-11-10T12:30:00.000Z', '2027-01-01', '01:15'],
    ['America/New_York', '2026-11-10T20:30:00.000Z', '2026-12-31', '17:15'],
  ])(
    'device zone %s sends the intended instant and displays the intended local day',
    (zone, expected, day, time) => {
      const moduleUrl = new URL('./guest-expiry.ts', import.meta.url).href;
      const script = `const { guestExpiryInstant, guestExpiryFields } = await import(${JSON.stringify(moduleUrl)});
      console.log(JSON.stringify({
        instant: guestExpiryInstant('2026-11-10', '15:30'),
        fields: guestExpiryFields('2026-12-31T22:15:00.000Z'),
        gap: guestExpiryInstant('2026-03-08', '02:30'),
      }));`;
      const output = execFileSync(process.execPath, ['--no-env-file', '-e', script], {
        env: { TZ: zone },
        encoding: 'utf8',
      });
      const actual: unknown = JSON.parse(output);
      expect(actual).toMatchObject({ instant: expected, fields: { day, time } });
      if (zone === 'America/New_York') expect(actual).toMatchObject({ gap: null });
    },
  );
});
