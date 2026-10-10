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

describe('numbers', () => {
  test('are grouped the way the locale groups them', () => {
    expect(createFormatters('en').number(1234567)).toBe('1,234,567');
    expect(createFormatters('tr').number(1234567)).toBe('1.234.567');
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
