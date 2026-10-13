/**
 * The theme choice, driven with a fake operating system.
 *
 * The page-load script is tested here too, because it repeats the storage key and
 * the decision the store makes: two copies of a rule are allowed only while a
 * failing test says when they drift (`CONTRIBUTING.md` §6.1).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  THEME_CHOICES,
  THEME_KEY,
  createThemeStore,
  parseChoice,
  resolveTheme,
  type DarkQuery,
  type KeyValueStorage,
  type ThemePorts,
} from './theme';

const memory = (
  initial: Record<string, string> = {},
): KeyValueStorage & { data: typeof initial } => {
  const data = { ...initial };
  return {
    data,
    getItem: (key): string | null => data[key] ?? null,
    setItem: (key, value): void => {
      data[key] = value;
    },
  };
};

/** An operating system whose preference the test can change. */
const system = (
  dark: boolean,
): DarkQuery & { flip: (dark: boolean) => void; listeners: number } => {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    get listeners(): number {
      return listeners.size;
    },
    addEventListener: (_type: 'change', listener: () => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: () => void): void => {
      listeners.delete(listener);
    },
    flip: (next: boolean): void => {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
  return query;
};

const target = (): ThemePorts['target'] & { attributes: Record<string, string> } => {
  const attributes: Record<string, string> = {};
  return {
    attributes,
    setAttribute: (name, value): void => {
      attributes[name] = value;
    },
  };
};

/** A store as the provider runs it: created, then connected. */
const connected = (ports: ThemePorts): ReturnType<typeof createThemeStore> => {
  const themeStore = createThemeStore(ports);
  themeStore.connect();
  return themeStore;
};

describe('choosing', () => {
  test('anything unrecognised is system, so an old value pins nothing', () => {
    expect(parseChoice(null)).toBe('system');
    expect(parseChoice('sepia')).toBe('system');
    expect(parseChoice('light')).toBe('light');
    expect(parseChoice('dark')).toBe('dark');
  });

  test('system is whatever the operating system says; a decision is not', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  test('offers the three choices, system first', () => {
    expect(THEME_CHOICES).toEqual(['system', 'light', 'dark']);
  });
});

describe('the store', () => {
  test('starts from the stored choice and writes it to the page', () => {
    const html = target();
    const { store } = createThemeStore({
      storage: memory({ [THEME_KEY]: 'light' }),
      query: system(true),
      target: html,
    });
    expect(store.getState().choice).toBe('light');
    expect(html.attributes['data-theme']).toBe('light');
  });

  test('with nothing stored it follows the operating system, and does not store that', () => {
    const storage = memory();
    const html = target();
    createThemeStore({ storage, query: system(true), target: html });
    expect(html.attributes['data-theme']).toBe('dark');
    expect(storage.data).toEqual({});
  });

  test('a choice is applied and remembered', () => {
    const storage = memory();
    const html = target();
    const { store } = connected({ storage, query: system(true), target: html });
    store.getState().setChoice('light');
    expect(html.attributes['data-theme']).toBe('light');
    expect(storage.data[THEME_KEY]).toBe('light');
    expect(store.getState().resolved).toBe('light');
  });

  test('only system follows the operating system when it changes its mind', () => {
    const os = system(true);
    const html = target();
    const { store } = connected({ storage: memory(), query: os, target: html });
    os.flip(false);
    expect(html.attributes['data-theme']).toBe('light');
    store.getState().setChoice('dark');
    os.flip(false);
    os.flip(true);
    os.flip(false);
    expect(html.attributes['data-theme']).toBe('dark');
    store.getState().setChoice('system');
    expect(html.attributes['data-theme']).toBe('light');
  });

  test('connecting listens, what it returns stops listening, and connecting again listens again', () => {
    const os = system(false);
    const html = target();
    const themeStore = createThemeStore({ storage: memory(), query: os, target: html });
    expect(os.listeners).toBe(0);
    const disconnect = themeStore.connect();
    expect(os.listeners).toBe(1);
    disconnect();
    expect(os.listeners).toBe(0);
    themeStore.store.getState().setChoice('dark');
    expect(html.attributes['data-theme']).toBe('light');
    // Connected again — what StrictMode does to the provider's effect — it writes the page and
    // follows the system once more, starting from what changed while it was not listening.
    themeStore.connect();
    expect(os.listeners).toBe(1);
    expect(html.attributes['data-theme']).toBe('dark');
    themeStore.store.getState().setChoice('system');
    os.flip(true);
    expect(html.attributes['data-theme']).toBe('dark');
    os.flip(false);
    expect(html.attributes['data-theme']).toBe('light');
  });

  test('a system preference that changed before connecting is caught up on connect', () => {
    const os = system(false);
    const html = target();
    const themeStore = createThemeStore({ storage: memory(), query: os, target: html });
    expect(html.attributes['data-theme']).toBe('light');
    os.flip(true); // with nobody listening yet
    themeStore.connect();
    expect(themeStore.store.getState().resolved).toBe('dark');
    expect(html.attributes['data-theme']).toBe('dark');
  });

  test('a storage that throws still gives a working theme', () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    const html = target();
    const { store } = connected({ storage: broken, query: system(false), target: html });
    expect(store.getState().choice).toBe('system');
    store.getState().setChoice('dark');
    expect(html.attributes['data-theme']).toBe('dark');
  });
});

describe('public/theme-init.js', () => {
  const source = readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8');

  /** Runs the script against a fake page, and returns the theme it set. */
  const run = (stored: string | null, dark: boolean, broken = false): string | undefined => {
    let set: string | undefined;
    const window = {
      localStorage: {
        getItem: (key: string): string | null => {
          if (broken) throw new Error('blocked');
          return key === THEME_KEY ? stored : null;
        },
      },
      matchMedia: (query: string): { matches: boolean } => ({
        matches: query === '(prefers-color-scheme: dark)' && dark,
      }),
    };
    const document = {
      documentElement: {
        setAttribute: (name: string, value: string): void => {
          if (name === 'data-theme') set = value;
        },
      },
    };
    runInNewContext(source, { window, document });
    return set;
  };

  test('reads the key the store writes', () => {
    expect(source).toContain(`'${THEME_KEY}'`);
  });

  test('decides exactly as the store does', () => {
    for (const stored of [null, 'light', 'dark', 'sepia'] as const) {
      for (const dark of [true, false]) {
        expect(run(stored, dark)).toBe(resolveTheme(parseChoice(stored), dark));
      }
    }
  });

  test('sets nothing, and does not throw, when storage is blocked', () => {
    expect(run(null, true, true)).toBeUndefined();
  });

  test('is referenced from index.html as a same-origin file, not inline', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html).not.toMatch(/<script>[^<]/);
  });
});
