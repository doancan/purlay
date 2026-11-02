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

/**
 * A locale's number format and plural rules, made once per `createTranslate`: building them is most of
 * what a call cost (about 21 µs against 0.6 µs), and a feed row with a count calls on every render.
 */
interface Formatters {
  readonly numbers: Intl.NumberFormat;
  readonly plurals: Intl.PluralRules;
}

const fill = (
  template: string,
  { numbers }: Formatters,
  params: Readonly<Record<string, unknown>>,
): string =>
  template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    if (typeof value === 'number') return numbers.format(value);
    return typeof value === 'string' ? value : whole;
  });

const choose = (message: Message, { plurals }: Formatters, count: unknown): string => {
  if (typeof message === 'string') return message;
  const category = typeof count === 'number' ? plurals.select(count) : 'other';
  return (category === 'other' ? undefined : message[category]) ?? message.other;
};

export const createTranslate = (locale: Locale, catalogue: Catalogue): Translate => {
  const formatters: Formatters = {
    numbers: new Intl.NumberFormat(locale),
    plurals: new Intl.PluralRules(locale),
  };
  // The public type is the precise one (`TranslateArgs`); this is the loose
  // function that satisfies it, and `i18n.test.ts` exercises every shape of call
  // through the precise type.
  const translate = (key: MessageKey, params?: Readonly<Record<string, unknown>>): string => {
    const values = params ?? {};
    return fill(choose(catalogue[key], formatters, values['count']), formatters, values);
  };
  return translate;
};
