/**
 * The words and the formatters, for components.
 *
 * **Nothing renders until the catalogue is there.** A person who reads Turkish
 * must never see English flash by, so until the first catalogue arrives the
 * provider shows its `fallback` — the application passes the prerendered shell's
 * skeleton, so the page is not blank, it is just not words yet. Switching
 * language later keeps the old words on screen until the new catalogue has
 * loaded, then swaps in one render.
 *
 * **Every outside thing is an argument** — storage, the browser's language list,
 * the loader, the element that carries `lang` — so a test drives a language
 * switch and a slow chunk by hand (D-46). The defaults are the browser's, built
 * when the provider first renders and not when this module is imported.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createFormatters, type Formatters } from './format';
import {
  detectLocale,
  loadCatalogue,
  rememberLocale,
  type CatalogueLoader,
  type LocaleStorage,
} from './locale';
import { createTranslate } from './translate';
import type { Catalogue, Locale, Translate } from './types';

export interface I18nPorts {
  readonly storage: LocaleStorage;
  readonly languages: readonly string[];
  readonly load: CatalogueLoader;
  readonly target: { setAttribute(name: string, value: string): void };
  /** A time zone to format in; the person's own when absent. */
  readonly timeZone?: string;
}

const browserPorts = (): I18nPorts => ({
  storage: window.localStorage,
  languages: navigator.languages,
  load: loadCatalogue,
  target: document.documentElement,
});

interface Loaded {
  readonly locale: Locale;
  readonly catalogue: Catalogue;
}

export interface I18n {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly t: Translate;
  readonly format: Formatters;
}

const I18nContext = createContext<I18n | null>(null);

interface I18nProviderProps {
  readonly ports?: I18nPorts;
  /** Shown until the first catalogue has loaded. */
  readonly fallback?: React.ReactNode;
  readonly children: React.ReactNode;
}

export const I18nProvider = ({
  ports,
  fallback = null,
  children,
}: I18nProviderProps): React.JSX.Element => {
  const [resolved] = useState(() => ports ?? browserPorts());
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  // The locale asked for, which may be ahead of the one showing while its
  // catalogue is on the way.
  const [wanted, setWanted] = useState<Locale>(() =>
    detectLocale(resolved.storage, resolved.languages),
  );

  useEffect(() => {
    let current = true;
    void resolved.load(wanted).then((catalogue) => {
      if (!current) return;
      resolved.target.setAttribute('lang', wanted);
      setLoaded({ locale: wanted, catalogue });
    });
    return (): void => {
      current = false;
    };
  }, [resolved, wanted]);

  const setLocale = useCallback(
    (locale: Locale): void => {
      rememberLocale(resolved.storage, locale);
      setWanted(locale);
    },
    [resolved],
  );

  const value = useMemo<I18n | null>(
    () =>
      loaded === null
        ? null
        : {
            locale: loaded.locale,
            setLocale,
            t: createTranslate(loaded.locale, loaded.catalogue),
            format: createFormatters(loaded.locale, resolved.timeZone),
          },
    [loaded, setLocale, resolved],
  );

  if (value === null) return <>{fallback}</>;
  return <I18nContext value={value}>{children}</I18nContext>;
};

export const useI18n = (): I18n => {
  const i18n = useContext(I18nContext);
  if (i18n === null) throw new Error('useI18n needs an <I18nProvider> above it');
  return i18n;
};
