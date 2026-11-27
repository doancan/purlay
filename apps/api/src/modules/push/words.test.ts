/**
 * A push uses the web catalogue's words for the reason and priority, in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUSH_WORDS, pushBody } from './words';

const CATALOGUE_KEY = {
  reminder: 'inbox.why.reminder',
  mention: 'inbox.why.mention',
  direct_message: 'inbox.why.direct',
  thread_reply: 'inbox.why.reply',
  reply_in: 'inbox.why.replyIn',
  channel_message: 'inbox.why.channel',
  group: 'inbox.why.group',
} as const;

const catalogue = (locale: 'en' | 'tr'): string =>
  readFileSync(join(import.meta.dir, `../../../../web/src/i18n/catalogue/${locale}.ts`), 'utf8');

const wordsAt = (source: string, key: string): string | undefined =>
  new RegExp(`'${key.replaceAll('.', '\\.')}': '([^']*)'`).exec(source)?.[1];

describe('what a push says', () => {
  test.each(['en', 'tr'] as const)('is the inbox’s own words, in %s', (locale) => {
    const source = catalogue(locale);
    for (const [reason, key] of Object.entries(CATALOGUE_KEY)) {
      expect({ key, words: wordsAt(source, key) }).toEqual({
        key,
        words: PUSH_WORDS[locale][reason as keyof typeof CATALOGUE_KEY],
      });
    }
  });

  test.each(['en', 'tr'] as const)('marks priority in the catalogue’s words, in %s', (locale) => {
    const source = catalogue(locale);
    const body = pushBody(locale, 'mention', 'Alice');
    for (const priority of ['important', 'urgent'] as const) {
      const label = wordsAt(source, `priority.${priority}`);
      if (label === undefined) throw new Error(`Missing priority.${priority} in ${locale}`);
      expect(pushBody(locale, 'mention', 'Alice', priority)).toBe(`${label} · ${body}`);
    }
  });

  test('names who did it', () => {
    expect(pushBody('en', 'mention', 'Alice')).toBe('Alice mentioned you');
    expect(pushBody('tr', 'direct_message', 'Ayşe')).toBe('Ayşe size yazdı');
  });
});
