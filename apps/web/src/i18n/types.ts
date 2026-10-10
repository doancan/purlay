/**
 * The shapes of a catalogue, and what the compiler can know about a message.
 *
 * **English is the source of the type** (D-41). `Catalogue` is derived from the
 * English module, so a key missing from Turkish, or a Turkish key English never
 * had, is a compile error rather than a blank in somebody's interface. What a
 * type cannot see — whether both languages use the same `{placeholders}` — is the
 * one thing `i18n.test.ts` checks at run time.
 *
 * **A message is a string or a plural.** A plural carries the CLDR categories its
 * language needs and always `other`; which one applies is `Intl.PluralRules`'s
 * decision, not ours, because English has two forms and Turkish one while a
 * language with six would simply fill six.
 */
import type { en } from './catalogue/en';

type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many';

type PluralMessage = Readonly<Partial<Record<PluralCategory, string>> & { other: string }>;

export type Message = string | PluralMessage;

export type MessageKey = keyof typeof en;

/** The English source, read as a type: every key, in the same shape in every language. */
export type Catalogue = {
  readonly [K in MessageKey]: (typeof en)[K] extends string ? string : PluralMessage;
};

export type Locale = 'en' | 'tr';

/** The locales this build has a catalogue for, in the order the picker lists them. */
export const LOCALES = ['en', 'tr'] as const satisfies readonly Locale[];

/** The text a message's placeholders are read from: a plural's `other`, or the string itself. */
type TemplateOf<M> = M extends string
  ? M
  : M extends { readonly other: infer O extends string }
    ? O
    : never;

type NamesIn<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | NamesIn<Rest>
  : never;

type IsPlural<K extends MessageKey> = (typeof en)[K] extends string ? false : true;

/**
 * What a call must pass for one key: each `{name}` in the English template, and
 * `count` as a number where the message is a plural (the count both picks the
 * form and is usually shown).
 */
type ParamsOf<K extends MessageKey> = {
  readonly [N in NamesIn<TemplateOf<(typeof en)[K]>>]: N extends 'count' ? number : string | number;
} & (IsPlural<K> extends true ? { readonly count: number } : unknown);

type NeedsParams<K extends MessageKey> = keyof ParamsOf<K> extends never ? false : true;

/** The arguments after the key: none for a plain string, the params object otherwise. */
type TranslateArgs<K extends MessageKey> = NeedsParams<K> extends true ? [params: ParamsOf<K>] : [];

export type Translate = <K extends MessageKey>(key: K, ...args: TranslateArgs<K>) => string;
