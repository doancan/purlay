/**
 * Looking a message up and filling it in — no library, because the job is a
 * lookup and a formatter call (D-41).
 *
 * **Plurals are the platform's decision.** `Intl.PluralRules` names the category
 * for a count in a locale; the message supplies the text for the categories its
 * language has, and `other` is the one every language must supply, so a category
 * the catalogue forgot falls back to something readable instead of to nothing.
 *
 * **A placeholder with no value stays visible** (`{name}`), on purpose. The types
 * make leaving one out a compile error; if a call gets past them, the braces in
 * the interface are a bug report that cannot be missed, where an empty string is
 * one that never gets filed.
 */
import type { Catalogue, Locale, Message, MessageKey, Translate } from './types';

const PLACEHOLDER = /\{(\w+)\}/g;

const fill = (
  template: string,
  locale: Locale,
  params: Readonly<Record<string, unknown>>,
): string =>
  template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (typeof value === 'number') return new Intl.NumberFormat(locale).format(value);
    return typeof value === 'string' ? value : whole;
  });

const choose = (message: Message, locale: Locale, count: unknown): string => {
  if (typeof message === 'string') return message;
  const category = typeof count === 'number' ? new Intl.PluralRules(locale).select(count) : 'other';
  return (category === 'other' ? undefined : message[category]) ?? message.other;
};

const lookup = (
  locale: Locale,
  catalogue: Catalogue,
  key: MessageKey,
  params: Readonly<Record<string, unknown>>,
): string => fill(choose(catalogue[key], locale, params['count']), locale, params);

export const createTranslate = (locale: Locale, catalogue: Catalogue): Translate => {
  // The public type is the precise one (`TranslateArgs`); this is the loose
  // function that satisfies it, and `i18n.test.ts` exercises every shape of call
  // through the precise type.
  const translate = (key: MessageKey, params?: Readonly<Record<string, unknown>>): string =>
    lookup(locale, catalogue, key, params ?? {});
  return translate;
};
