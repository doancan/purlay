/**
 * What a push says, in the person's language (D-41, D-126 §2–3): who, and why it needs them — the
 * inbox's own words, never what was written. `words.test.ts` holds them to the web catalogue's
 * `inbox.why.*`, so a device and the inbox cannot say a thing two ways.
 */
import type { PushLocale } from '@purlay/types';
import type { NEEDS_YOU } from '../messages/delivery';

type Reason = (typeof NEEDS_YOU)[number];

export const PUSH_WORDS: Readonly<Record<PushLocale, Readonly<Record<Reason, string>>>> = {
  en: {
    mention: '{name} mentioned you',
    direct_message: '{name} wrote to you',
    thread_reply: '{name} replied in your thread',
    channel_message: '{name} wrote',
  },
  tr: {
    mention: '{name} senden bahsetti',
    direct_message: '{name} sana yazdı',
    thread_reply: '{name} thread’ine yanıt verdi',
    channel_message: '{name} yazdı',
  },
};

/** The reason, in the person's language, with who did it. */
export const pushBody = (locale: PushLocale, reason: Reason, name: string): string =>
  PUSH_WORDS[locale][reason].replace('{name}', name);
