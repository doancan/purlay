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
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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

  // The language the person chose, remembered only once its words have arrived (#334).
  const chosen = useRef<Locale | null>(null);
  // The language showing, for where to fall back to; read, never a reason to load again.
  const showing = useRef<Locale | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);

  useEffect(() => {
    let current = true;
    resolved.load(wanted).then(
      (catalogue) => {
        if (!current) return;
        resolved.target.setAttribute('lang', wanted);
        if (chosen.current === wanted) rememberLocale(resolved.storage, wanted);
        showing.current = wanted;
        setLoaded({ locale: wanted, catalogue });
      },
      (error: unknown) => {
        if (!current) return;
        chosen.current = null;
        // A catalogue that did not arrive — a build that has gone, the network — leaves the page
        // in the language it has, or English if it has none yet; the update bar offers the reload
        // that brings the rest. English itself not arriving leaves nothing to say anything in.
        const instead = showing.current ?? (wanted === 'en' ? null : 'en');
        if (instead === null) {
          setFailure(error instanceof Error ? error : new Error(String(error)));
        } else {
          setWanted(instead);
        }
      },
    );
    return (): void => {
      current = false;
    };
  }, [resolved, wanted]);

  const setLocale = useCallback((locale: Locale): void => {
    chosen.current = locale;
    setWanted(locale);
  }, []);

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

  if (failure !== null) throw failure;
  if (value === null) return <>{fallback}</>;
  return <I18nContext value={value}>{children}</I18nContext>;
};

export const useI18n = (): I18n => {
  const i18n = useContext(I18nContext);
  if (i18n === null) throw new Error('useI18n needs an <I18nProvider> above it');
  return i18n;
};
