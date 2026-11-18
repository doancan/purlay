/**
 * The times "Send later" offers, worked out where the viewer is: a preset is a wall-clock time in
 * their zone, so the zone, the weekday and the clocks changing are what these cases are about.
 */
import { describe, expect, test } from 'bun:test';
import { createFormatters } from '../../../i18n/format';
import { createTranslate } from '../../../i18n/translate';
import { en } from '../../../i18n/catalogue/en';
import { tr } from '../../../i18n/catalogue/tr';
import { describeWhen, schedulePresets, type PresetId } from './presets';
import { checkSendAt, fromInputValue, toInputValue } from './typed-time';

const presetsAt = (now: string, timeZone: string): Partial<Record<PresetId, string>> =>
  Object.fromEntries(
    schedulePresets(new Date(now), createFormatters('en', timeZone)).map((preset) => [
      preset.id,
      preset.at.toISOString(),
    ]),
  );

describe('the presets', () => {
  test('are an hour from now, tomorrow at nine and next Monday at nine in the viewer’s zone', () => {
    // Wednesday 2026-09-09, 15:30 in Istanbul (UTC+3).
    expect(presetsAt('2026-09-09T12:30:00Z', 'Europe/Istanbul')).toEqual({
      hour: '2026-09-09T13:30:00.000Z',
      tomorrow: '2026-09-10T06:00:00.000Z',
      monday: '2026-09-14T06:00:00.000Z',
    });
  });

  test('a late evening in Istanbul is already the next day in UTC, and tomorrow is Istanbul’s', () => {
    // Wednesday 23:30 in Istanbul is 20:30 UTC: tomorrow at nine there is Thursday 06:00 UTC.
    expect(presetsAt('2026-09-09T20:30:00Z', 'Europe/Istanbul').tomorrow).toBe(
      '2026-09-10T06:00:00.000Z',
    );
    // 01:30 on Thursday in Istanbul is still Wednesday in New York: the weekday is the viewer's.
    expect(presetsAt('2026-09-09T22:30:00Z', 'Europe/Istanbul').tomorrow).toBe(
      '2026-09-11T06:00:00.000Z',
    );
  });

  test('keep nine o’clock across a change of the clocks, and an hour stays an hour', () => {
    // Saturday 2026-03-07 20:00 in New York (UTC-5): the clocks go forward in the night.
    expect(presetsAt('2026-03-08T01:00:00Z', 'America/New_York')).toMatchObject({
      hour: '2026-03-08T02:00:00.000Z',
      tomorrow: '2026-03-08T13:00:00.000Z',
    });
    // Saturday 2026-10-31 20:00 in Berlin (UTC+1 after the night's change back, UTC+2 now).
    expect(presetsAt('2026-10-31T18:00:00Z', 'Europe/Berlin')).toMatchObject({
      tomorrow: '2026-11-01T08:00:00.000Z',
    });
    expect(presetsAt('2026-10-24T18:00:00Z', 'Europe/Berlin')).toMatchObject({
      tomorrow: '2026-10-25T08:00:00.000Z',
    });
  });

  test('Monday is the next one, from Tuesday to Saturday', () => {
    const monday = (now: string): string | undefined => presetsAt(now, 'UTC').monday;
    expect(monday('2026-09-08T10:00:00Z')).toBe('2026-09-14T09:00:00.000Z');
    expect(monday('2026-09-12T10:00:00Z')).toBe('2026-09-14T09:00:00.000Z');
  });

  test('there is none on a Sunday, when Monday is tomorrow, and none on a Monday, when it would read as today', () => {
    expect(presetsAt('2026-09-13T10:00:00Z', 'UTC').monday).toBeUndefined();
    expect(presetsAt('2026-09-14T10:00:00Z', 'UTC').monday).toBeUndefined();
    // Sunday evening UTC is already Monday in Istanbul.
    expect(presetsAt('2026-09-13T22:00:00Z', 'Europe/Istanbul').monday).toBeUndefined();
    // And Sunday night in New York is still Sunday while it is Monday in UTC.
    expect(presetsAt('2026-09-14T02:00:00Z', 'America/New_York').monday).toBeUndefined();
    expect(presetsAt('2026-09-14T02:00:00Z', 'America/New_York').tomorrow).toBe(
      '2026-09-14T13:00:00.000Z',
    );
  });

  test('roll over a month and a year', () => {
    expect(presetsAt('2026-12-31T10:00:00Z', 'UTC')).toMatchObject({
      tomorrow: '2027-01-01T09:00:00.000Z',
      monday: '2027-01-04T09:00:00.000Z',
    });
    // Saturday 2026-02-28: Monday is 2 March.
    expect(presetsAt('2026-02-28T10:00:00Z', 'UTC').monday).toBe('2026-03-02T09:00:00.000Z');
    // 2028 is a leap year.
    expect(presetsAt('2028-02-28T10:00:00Z', 'UTC').tomorrow).toBe('2028-02-29T09:00:00.000Z');
  });
});

describe('the time that is typed', () => {
  const istanbul = createFormatters('en', 'Europe/Istanbul');
  const now = new Date('2026-09-09T12:00:00Z');

  test('is read as a wall-clock time in the viewer’s zone, and written back the same way', () => {
    const at = fromInputValue('2026-09-10T09:30', istanbul);
    expect(at?.toISOString()).toBe('2026-09-10T06:30:00.000Z');
    expect(at === null ? '' : toInputValue(at, istanbul)).toBe('2026-09-10T09:30');
  });

  test('is nothing when it is empty or not a date and time', () => {
    for (const value of ['', '2026-09-10', '2026-02-30T10:00', '2026-09-10T24:00', 'soon']) {
      expect(fromInputValue(value, istanbul)).toBeNull();
    }
  });

  test('is refused when it is not a time, in the past, under a minute away or over a year away', () => {
    const at = (value: string): Date | null => fromInputValue(value, istanbul);
    expect(checkSendAt(null, now)).toBe('invalid');
    expect(checkSendAt(at('2026-09-09T14:00'), now)).toBe('tooSoon');
    expect(checkSendAt(at('2026-09-09T15:00'), now)).toBe('tooSoon');
    expect(checkSendAt(at('2026-09-09T15:01'), now)).toBe('ok');
    expect(checkSendAt(at('2026-09-09T14:59'), now)).toBe('tooSoon');
    expect(checkSendAt(new Date(now.getTime() + 365 * 86_400_000), now)).toBe('ok');
    expect(checkSendAt(new Date(now.getTime() + 365 * 86_400_000 + 1), now)).toBe('tooFar');
  });
});

describe('how a time is said', () => {
  const now = new Date('2026-09-09T12:00:00Z');
  const say = (at: string, locale: 'en' | 'tr'): string =>
    describeWhen(
      new Date(at),
      now,
      createFormatters(locale, 'Europe/Istanbul'),
      createTranslate(locale, locale === 'en' ? en : tr),
    );

  test('is today or tomorrow with the time, and a day beyond', () => {
    expect(say('2026-09-09T14:30:00Z', 'en')).toBe('Today at 17:30');
    expect(say('2026-09-10T06:00:00Z', 'en')).toBe('Tomorrow at 09:00');
    expect(say('2026-09-11T06:00:00Z', 'en')).toBe('Fri, Sep 11 at 09:00');
    expect(say('2027-01-04T06:00:00Z', 'en')).toBe('Jan 4, 2027 at 09:00');
  });

  test('is Turkish the way a person says it', () => {
    expect(say('2026-09-09T14:30:00Z', 'tr')).toBe('Bugün 17:30');
    expect(say('2026-09-10T06:00:00Z', 'tr')).toBe('Yarın 09:00');
    expect(say('2026-09-11T06:00:00Z', 'tr')).toBe('11 Eyl Cum 09:00');
  });

  test('a day that has passed is said as a day, not as today', () => {
    expect(say('2026-09-08T06:00:00Z', 'en')).toBe('Yesterday at 09:00');
  });
});
