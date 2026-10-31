/**
 * The catalogues, the lookup and the formatters.
 *
 * The compiler guarantees both languages have the same keys; these check what it
 * cannot — that they use the same placeholders, that a plural only names forms its
 * language has, and that the helpers do what `UX.md` says a timestamp does.
 */
import { describe, expect, test } from 'bun:test';
import { en } from './catalogue/en';
import { tr } from './catalogue/tr';
import { createFormatters } from './format';
import {
  LOCALE_KEY,
  detectLocale,
  loadCatalogue,
  parseLocale,
  readStoredLocale,
  rememberLocale,
  type LocaleStorage,
} from './locale';
import { createTranslate } from './translate';
import type { Catalogue, Message } from './types';

const text = (message: Message): readonly string[] =>
  typeof message === 'string' ? [message] : Object.values(message);

const placeholders = (message: Message): readonly string[] =>
  [
    ...new Set(
      text(message).flatMap((form) => [...form.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '')),
    ),
  ].sort();

describe('the catalogues agree', () => {
  const keys = Object.keys(en) as (keyof typeof en)[];

  test('Turkish has every key English has, and no other', () => {
    expect(Object.keys(tr).sort()).toEqual([...keys].sort());
  });

  test.each(keys)('%s uses the same placeholders in both languages', (key) => {
    expect(placeholders(tr[key])).toEqual(placeholders(en[key]));
  });

  test.each(keys)(
    '%s: a plural is a plural in both, and names only forms its language has',
    (key) => {
      const english: Message = en[key];
      const turkish: Message = tr[key];
      expect(typeof turkish).toBe(typeof english);
      for (const [message, locale] of [
        [english, 'en'],
        [turkish, 'tr'],
      ] as const) {
        if (typeof message === 'string') continue;
        const has = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
        expect(
          Object.keys(message).filter((form) => form !== 'other' && !has.includes(form as never)),
        ).toEqual([]);
        // A plural shows its count, or it is not about a count.
        expect(placeholders(message)).toContain('count');
      }
    },
  );

  test('no message is empty', () => {
    for (const catalogue of [en, tr] as readonly Catalogue[]) {
      for (const message of Object.values(catalogue)) {
        for (const form of text(message)) expect(form.trim()).not.toBe('');
      }
    }
  });
});

describe('looking a message up', () => {
  const t = createTranslate('en', en);

  test('a plain string comes back as it is', () => {
    expect(t('common.close')).toBe('Close');
  });

  test('fills a placeholder with a string', () => {
    expect(t('composer.label', { channel: 'api' })).toBe('Message api');
  });

  test('fills several, and a number is shown in the locale’s own format', () => {
    expect(t('thread.open', { replies: '4 replies', when: '12m ago' })).toBe(
      'Open · 4 replies · last 12m ago',
    );
    expect(t('message.code.expand', { count: 12_345 })).toBe('Show all 12,345 lines');
    expect(createTranslate('tr', tr)('message.code.expand', { count: 12_345 })).toBe(
      'Tüm 12.345 satırı göster',
    );
  });

  test('chooses the plural form the language says', () => {
    expect(t('thread.replies', { count: 1 })).toBe('1 reply');
    expect(t('thread.replies', { count: 4 })).toBe('4 replies');
    expect(t('thread.replies', { count: 0 })).toBe('0 replies');
  });

  test('Turkish has one form and uses it for every count', () => {
    const turkish = createTranslate('tr', tr);
    expect(turkish('thread.replies', { count: 1 })).toBe('1 yanıt');
    expect(turkish('thread.replies', { count: 4 })).toBe('4 yanıt');
  });

  test('a form the catalogue lacks falls back to other, not to nothing', () => {
    const sparse: Catalogue = { ...en, 'thread.replies': { other: '{count} replies' } };
    expect(createTranslate('en', sparse)('thread.replies', { count: 1 })).toBe('1 replies');
  });

  test('a placeholder nobody filled stays visible', () => {
    const loose = t as unknown as (key: string, params?: Record<string, unknown>) => string;
    expect(loose('composer.label', {})).toBe('Message {channel}');
    expect(loose('composer.label')).toBe('Message {channel}');
  });

  test('the types refuse what would be wrong', () => {
    // Never called: these lines exist for the compiler, which fails the build if
    // any `@ts-expect-error` below stops being an error.
    const refused = (): void => {
      // @ts-expect-error -- a message with a placeholder needs its params (#138)
      t('composer.label');
      // @ts-expect-error -- and the placeholder's name must be right (#138)
      t('composer.label', { chanel: 'api' });
      // @ts-expect-error -- a plural's count is a number (#138)
      t('thread.replies', { count: '4' });
      // @ts-expect-error -- a key that is not in the catalogue does not exist (#138)
      t('composer.nope');
      // @ts-expect-error -- a plain string takes no params (#138)
      t('common.close', { count: 1 });
    };
    expect(typeof refused).toBe('function');
  });
});

describe('timestamps', () => {
  const now = new Date('2026-10-10T14:40:00Z');
  const f = createFormatters('en', 'UTC');
  const at = (iso: string): string => f.time(iso, now);

  test('under a minute is now, and a clock ahead of ours is still now', () => {
    expect(at('2026-10-10T14:39:40Z')).toBe('now');
    expect(at('2026-10-10T14:40:05Z')).toBe('now');
  });

  test('under an hour is relative, in the short form UX.md shows', () => {
    expect(at('2026-10-10T14:28:00Z')).toBe('12m ago');
    expect(at('2026-10-10T13:41:00Z')).toBe('59m ago');
  });

  test('the rest of the day is HH:mm on a 24-hour clock', () => {
    expect(at('2026-10-10T13:40:00Z')).toBe('13:40');
    expect(at('2026-10-10T00:05:00Z')).toBe('00:05');
  });

  test('another day is MMM D, and gains the year only when it is not this one', () => {
    expect(at('2026-10-06T09:00:00Z')).toBe('Oct 6');
    expect(at('2025-10-06T09:00:00Z')).toBe('Oct 6, 2025');
  });

  test('accepts a Date as well as the API’s string', () => {
    expect(f.time(new Date('2026-10-10T14:28:00Z'), now)).toBe('12m ago');
  });

  test('the absolute time is complete', () => {
    expect(f.absolute('2026-10-10T14:32:00Z')).toMatch(/^Oct 10, 2026.*2:32\sPM$/);
  });

  test('Turkish reads the same rules in Turkish', () => {
    const turkish = createFormatters('tr', 'UTC');
    expect(turkish.time('2026-10-10T14:28:00Z', now)).toBe('12 dk. önce');
    expect(turkish.time('2026-10-10T13:40:00Z', now)).toBe('13:40');
    expect(turkish.time('2026-10-06T09:00:00Z', now)).toBe('6 Eki');
  });

  test('the person’s own time zone is used when none is named', () => {
    const own = createFormatters('en');
    expect(own.time(new Date(now.getTime() - 5 * 60_000), now)).toBe('5m ago');
  });
});

describe('a day and its start, where the viewer is (D-224)', () => {
  const at = (timeZone: string, day: string): string =>
    createFormatters('en', timeZone).dayStart(day);

  test('a day begins at its midnight there, said as the UTC instant', () => {
    expect(at('UTC', '2026-10-31')).toBe('2026-10-31T00:00:00.000Z');
    expect(at('Europe/Istanbul', '2026-10-01')).toBe('2026-09-30T21:00:00.000Z');
    expect(at('Asia/Kolkata', '2026-01-01')).toBe('2025-12-31T18:30:00.000Z');
    expect(at('Pacific/Kiritimati', '2026-01-01')).toBe('2025-12-31T10:00:00.000Z');
  });

  test('on the days the clocks change, and where a change skips midnight itself', () => {
    expect(at('America/New_York', '2026-03-08')).toBe('2026-03-08T05:00:00.000Z');
    expect(at('America/New_York', '2026-11-01')).toBe('2026-11-01T04:00:00.000Z');
    // São Paulo went from 23:59:59 to 01:00 on 4 November 2018: the day began at one.
    expect(at('America/Sao_Paulo', '2018-11-04')).toBe('2018-11-04T03:00:00.000Z');
  });

  test('takes the offset in force that day, on either side of a change of the clocks', () => {
    // Summer time ends at 02:00 on 1 November 2026: the day before starts at -4, the day after at -5;
    // it begins at 02:00 on 8 March 2026, so the day after starts at -4.
    expect(at('America/New_York', '2026-10-31')).toBe('2026-10-31T04:00:00.000Z');
    expect(at('America/New_York', '2026-11-02')).toBe('2026-11-02T05:00:00.000Z');
    expect(at('America/New_York', '2026-03-09')).toBe('2026-03-09T04:00:00.000Z');
    // Ahead of UTC, where the change is late at night: Sydney goes +10 to +11 on 4 October 2026.
    expect(at('Australia/Sydney', '2026-10-04')).toBe('2026-10-03T14:00:00.000Z');
    expect(at('Australia/Sydney', '2026-10-05')).toBe('2026-10-04T13:00:00.000Z');
  });

  test('the day an instant falls on there, which a day’s start reads back as', () => {
    const istanbul = createFormatters('en', 'Europe/Istanbul');
    expect(istanbul.isoDay('2026-09-30T21:00:00.000Z')).toBe('2026-10-01');
    expect(istanbul.isoDay(new Date('2026-09-30T20:59:59.999Z'))).toBe('2026-09-30');
    // A year still being typed in a date field (`0002`) is not read as 1902.
    expect(istanbul.isoDay(istanbul.dayStart('0002-10-01'))).toBe('0002-10-01');
  });
});

describe('day dividers', () => {
  const now = new Date('2026-10-10T14:40:00Z');
  const f = createFormatters('en', 'UTC');
  const words = { today: 'Today', yesterday: 'Yesterday' };

  test('today and yesterday are words', () => {
    expect(f.day('2026-10-10T01:00:00Z', now, words)).toBe('Today');
    expect(f.day('2026-10-09T23:59:00Z', now, words)).toBe('Yesterday');
  });

  test('yesterday is a calendar day even across a month boundary', () => {
    expect(f.day('2026-09-30T12:00:00Z', new Date('2026-10-01T09:00:00Z'), words)).toBe(
      'Yesterday',
    );
  });

  test('older days name the weekday, and the year when it is not this one', () => {
    expect(f.day('2026-10-06T09:00:00Z', now, words)).toBe('Tue, Oct 6');
    expect(f.day('2025-10-06T09:00:00Z', now, words)).toBe('Oct 6, 2025');
  });
});

describe('names in a list', () => {
  test('are joined the way the language joins them', () => {
    expect(createFormatters('en').list(['You'])).toBe('You');
    expect(createFormatters('en').list(['Alice', 'Bob', '3 others'])).toBe(
      'Alice, Bob, and 3 others',
    );
    expect(createFormatters('tr').list(['Alice', 'Bob', '3 kişi daha'])).toBe(
      'Alice, Bob ve 3 kişi daha',
    );
  });
});

describe('numbers', () => {
  test('are grouped the way the locale groups them', () => {
    expect(createFormatters('en').number(1234567)).toBe('1,234,567');
    expect(createFormatters('tr').number(1234567)).toBe('1.234.567');
  });

  test('a size in bytes, kilobytes, megabytes or gigabytes, in each language’s way', () => {
    const en = createFormatters('en');
    const tr = createFormatters('tr');
    // A count of bytes is a plural in English: nothing is "0 bytes", one is "1 byte" (Turkish has one form).
    expect(en.bytes(0)).toBe('0 bytes');
    expect(en.bytes(1)).toBe('1 byte');
    expect(en.bytes(512)).toBe('512 bytes');
    expect(tr.bytes(0)).toBe('0 bayt');
    expect(tr.bytes(512)).toBe('512 bayt');
    expect(en.bytes(1536)).toBe('1.5 kB');
    expect(en.bytes(3 * 1024 * 1024)).toBe('3 MB');
    expect(tr.bytes(1536)).toBe('1,5 kB');
    expect(tr.bytes(25 * 1024 * 1024)).toBe('25 MB');
    // A workspace's storage and its quota (D-173).
    expect(en.bytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(en.bytes(1.25 * 1024 ** 3)).toBe('1.3 GB');
    expect(tr.bytes(1.25 * 1024 ** 3)).toBe('1,3 GB');
    expect(en.bytes(1024 ** 3 - 1)).toBe('1,024 MB');
  });
});

describe('choosing a locale', () => {
  const store = (
    initial: Record<string, string> = {},
  ): LocaleStorage & { data: Record<string, string> } => {
    const data = { ...initial };
    return {
      data,
      getItem: (key): string | null => data[key] ?? null,
      setItem: (key, value): void => {
        data[key] = value;
      },
    };
  };

  test('only the languages this build has are languages', () => {
    expect(parseLocale('tr')).toBe('tr');
    expect(parseLocale('de')).toBeNull();
    expect(parseLocale(null)).toBeNull();
  });

  test('what the person chose wins over the browser', () => {
    expect(detectLocale(store({ [LOCALE_KEY]: 'tr' }), ['en-US'])).toBe('tr');
  });

  test('otherwise the browser’s first language we speak, by primary subtag', () => {
    expect(detectLocale(store(), ['de-DE', 'tr-TR', 'en'])).toBe('tr');
    expect(detectLocale(store(), ['EN-gb'])).toBe('en');
  });

  test('otherwise English', () => {
    expect(detectLocale(store(), ['de', 'fr'])).toBe('en');
    expect(detectLocale(store(), [])).toBe('en');
  });

  test('a stored value this build does not know is ignored', () => {
    expect(detectLocale(store({ [LOCALE_KEY]: 'klingon' }), ['tr'])).toBe('tr');
  });

  test('remembers a choice, and survives storage that throws', () => {
    const storage = store();
    rememberLocale(storage, 'tr');
    expect(readStoredLocale(storage)).toBe('tr');
    const broken: LocaleStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => {
      rememberLocale(broken, 'en');
    }).not.toThrow();
    expect(readStoredLocale(broken)).toBeNull();
  });

  test('each catalogue loads as its own chunk', async () => {
    expect(await loadCatalogue('en')).toBe(en);
    expect(await loadCatalogue('tr')).toBe(tr);
  });
});
