/**
 * Renders a component inside the real provider tree, over a fake world.
 *
 * **The same tree the application mounts** (`app/providers.tsx`), so a component
 * that works here has what it needs in production and a missing provider is found
 * by the first test, not by the first user. What is faked is only what the tree
 * reaches outside the process for: storage, history, timers, the colour scheme and
 * the catalogue loader.
 *
 * It is `async` because the words are: the i18n provider renders nothing until its
 * catalogue has loaded, and the loader here resolves immediately, so one flush of
 * the microtask queue inside `act` is all the wait there is.
 *
 * The global `screen` is unusable under this DOM and lint refuses it
 * (`testing/dom.ts`); use the queries this returns.
 */
import { act, render, type RenderResult } from '@testing-library/react';
import { AppProviders } from '../app/providers';
import { en } from '../i18n/catalogue/en';
import { tr } from '../i18n/catalogue/tr';
import type { Locale } from '../i18n/types';
import { fakeColourScheme, fakeHistory, fakeSchedule, memoryStorage } from './fakes';

export interface WorldOptions {
  readonly locale?: Locale;
  /** The address the page is at when it starts. */
  readonly path?: string;
  /** What the operating system prefers. */
  readonly dark?: boolean;
  /** The theme the person already chose, if they did. */
  readonly theme?: 'light' | 'dark';
}

export const renderApp = async (
  ui: React.ReactElement,
  { locale = 'en', path = '/', dark = false, theme }: WorldOptions = {},
): Promise<RenderResult & { readonly world: ReturnType<typeof makeWorld> }> => {
  const world = makeWorld({ locale, path, dark, ...(theme === undefined ? {} : { theme }) });
  const result = render(
    <AppProviders
      ports={{
        theme: { storage: world.themeStorage, query: world.colourScheme, target: world.page },
        i18n: {
          storage: world.localeStorage,
          languages: [locale],
          load: (wanted) => Promise.resolve(wanted === 'tr' ? tr : en),
          target: world.page,
          timeZone: 'UTC',
        },
        history: world.history,
        schedule: world.timers.schedule,
      }}
    >
      {ui}
    </AppProviders>,
  );
  // Let the catalogue load: the provider renders nothing until it has.
  await act(async () => {
    await Promise.resolve();
  });
  return Object.assign(result, { world });
};

const makeWorld = ({
  locale,
  path,
  dark,
  theme,
}: Required<Pick<WorldOptions, 'locale' | 'path' | 'dark'>> & Pick<WorldOptions, 'theme'>): {
  readonly themeStorage: ReturnType<typeof memoryStorage>;
  readonly localeStorage: ReturnType<typeof memoryStorage>;
  readonly colourScheme: ReturnType<typeof fakeColourScheme>;
  readonly history: ReturnType<typeof fakeHistory>;
  readonly timers: ReturnType<typeof fakeSchedule>;
  readonly page: {
    readonly attributes: Record<string, string>;
    readonly setAttribute: (name: string, value: string) => void;
  };
  readonly locale: Locale;
} => {
  const attributes: Record<string, string> = {};
  return {
    themeStorage: memoryStorage(theme === undefined ? {} : { 'purlay.theme': theme }),
    localeStorage: memoryStorage(),
    colourScheme: fakeColourScheme(dark),
    history: fakeHistory(path),
    timers: fakeSchedule(),
    page: {
      attributes,
      setAttribute: (name, value): void => {
        attributes[name] = value;
      },
    },
    locale,
  };
};
