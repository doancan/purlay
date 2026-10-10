/**
 * Which theme is showing, who chose it, and where that choice is kept.
 *
 * **Both themes ship together** (D-98): the tokens declare every colour in dark
 * and light, and contrast is computed in each, so the choice is only ever a
 * switch of `data-theme` on `<html>` — never a second stylesheet and never a
 * class a component has to know about.
 *
 * **Three choices, two themes.** `system` follows the operating system until a
 * person decides otherwise, and keeps following it afterwards if they go back to
 * `system`; `light` and `dark` are decisions. The choice is per device
 * (`localStorage`, no schema), exactly like the locale (D-41).
 *
 * **Every outside thing is an argument** — storage, the media query, the element
 * that carries the attribute — so a test flips the operating system's preference
 * by hand instead of needing a browser to do it (D-46). Storage may also throw
 * (private windows, a full quota, a blocked site): a theme that cannot be
 * remembered is still a theme, so failures are swallowed here and nowhere else.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';

export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

/**
 * The key `public/theme-init.js` reads before first paint. That script cannot
 * import this module — it runs before any module does — so it repeats the string
 * and `theme.test.ts` fails if the two differ.
 */
export const THEME_KEY = 'purlay.theme';

/** The order the toggle offers them in. */
export const THEME_CHOICES = ['system', 'light', 'dark'] as const satisfies readonly ThemeChoice[];

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The part of `MediaQueryList` this reads: `(prefers-color-scheme: dark)`. */
export interface DarkQuery {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** The part of `<html>` this writes. */
export interface ThemeTarget {
  setAttribute(name: string, value: string): void;
}

export interface ThemePorts {
  readonly storage: KeyValueStorage;
  readonly query: DarkQuery;
  readonly target: ThemeTarget;
}

/** Anything unrecognised is `system`: a value from an older build must not pin a theme nobody chose. */
export const parseChoice = (raw: string | null): ThemeChoice =>
  raw === 'light' || raw === 'dark' ? raw : 'system';

export const resolveTheme = (choice: ThemeChoice, prefersDark: boolean): ResolvedTheme =>
  choice === 'system' ? (prefersDark ? 'dark' : 'light') : choice;

export interface ThemeState {
  readonly choice: ThemeChoice;
  readonly resolved: ResolvedTheme;
  readonly setChoice: (choice: ThemeChoice) => void;
}

export interface ThemeStore {
  readonly store: StoreApi<ThemeState>;
  /** Stops listening to the operating system. */
  readonly dispose: () => void;
}

const read = (storage: KeyValueStorage): ThemeChoice => {
  try {
    return parseChoice(storage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
};

const remember = (storage: KeyValueStorage, choice: ThemeChoice): void => {
  try {
    storage.setItem(THEME_KEY, choice);
  } catch {
    // Not remembered, still applied: see the header.
  }
};

export const createThemeStore = ({ storage, query, target }: ThemePorts): ThemeStore => {
  const initial = read(storage);
  const store = createStore<ThemeState>()((set) => ({
    choice: initial,
    resolved: resolveTheme(initial, query.matches),
    setChoice: (choice): void => {
      remember(storage, choice);
      set({ choice, resolved: resolveTheme(choice, query.matches) });
    },
  }));

  const apply = (state: ThemeState): void => {
    target.setAttribute('data-theme', state.resolved);
  };
  apply(store.getState());
  const unsubscribe = store.subscribe(apply);

  // The operating system can change its mind while the page is open (a schedule
  // at dusk is the common case); only `system` is entitled to follow it.
  const followSystem = (): void => {
    const { choice } = store.getState();
    if (choice === 'system') store.setState({ resolved: resolveTheme(choice, query.matches) });
  };
  query.addEventListener('change', followSystem);

  return {
    store,
    dispose: (): void => {
      query.removeEventListener('change', followSystem);
      unsubscribe();
    },
  };
};
