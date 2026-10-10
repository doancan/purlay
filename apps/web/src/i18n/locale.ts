/**
 * Which language, and how its catalogue is fetched.
 *
 * **Selection** (D-41): what the person chose, else the browser's own ordered list
 * of preferred languages, else English. The choice lives in `localStorage` — per
 * device, no schema — until a `users.locale` column exists for the first text the
 * *server* writes.
 *
 * **Loading.** Every catalogue is its own chunk, English included, so a Turkish
 * reader never downloads English and the build can say how large each is. A
 * region ("tr-TR") and a script are not separate languages here: the primary
 * subtag decides.
 */
import { LOCALES, type Catalogue, type Locale } from './types';

/** The key the locale is stored under, beside `purlay.theme`. */
export const LOCALE_KEY = 'purlay.locale';

export interface LocaleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const parseLocale = (raw: string | null): Locale | null =>
  LOCALES.find((locale) => locale === raw) ?? null;

/** `tr-TR` → `tr`; anything this build has no catalogue for → null. */
const fromTag = (tag: string): Locale | null =>
  parseLocale(tag.toLowerCase().split('-')[0] ?? null);

export const readStoredLocale = (storage: LocaleStorage): Locale | null => {
  try {
    return parseLocale(storage.getItem(LOCALE_KEY));
  } catch {
    return null;
  }
};

export const rememberLocale = (storage: LocaleStorage, locale: Locale): void => {
  try {
    storage.setItem(LOCALE_KEY, locale);
  } catch {
    // Not remembered, still applied — the same trade as the theme's.
  }
};

export const detectLocale = (storage: LocaleStorage, languages: readonly string[]): Locale => {
  const stored = readStoredLocale(storage);
  if (stored !== null) return stored;
  for (const tag of languages) {
    const found = fromTag(tag);
    if (found !== null) return found;
  }
  return 'en';
};

export type CatalogueLoader = (locale: Locale) => Promise<Catalogue>;

/** The real loader: one dynamic import per language, so each is one chunk. */
export const loadCatalogue: CatalogueLoader = async (locale) =>
  locale === 'tr' ? (await import('./catalogue/tr')).tr : (await import('./catalogue/en')).en;
