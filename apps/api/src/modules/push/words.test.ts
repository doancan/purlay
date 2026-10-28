/**
 * A push says what the inbox says: the words are the web catalogue's `inbox.why.*`, in both
 * languages, read from the catalogue's own source.
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

describe('what a push says', () => {
  test.each(['en', 'tr'] as const)('is the inbox’s own words, in %s', (locale) => {
    const source = catalogue(locale);
    for (const [reason, key] of Object.entries(CATALOGUE_KEY)) {
      const line = new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}': '([^']*)'`).exec(
        source,
      );
      expect({ key, words: line?.[1] }).toEqual({
        key,
        words: PUSH_WORDS[locale][reason as keyof typeof CATALOGUE_KEY],
      });
    }
  });

  test('names who did it', () => {
    expect(pushBody('en', 'mention', 'Alice')).toBe('Alice mentioned you');
    expect(pushBody('tr', 'direct_message', 'Ayşe')).toBe('Ayşe sana yazdı');
  });
});
