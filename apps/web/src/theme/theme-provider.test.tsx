import { installDom } from '../testing/dom';
import { describe, expect, spyOn, test } from 'bun:test';
import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { ThemeProvider, useTheme } from './theme-provider';
import type { DarkQuery, KeyValueStorage, ThemePorts } from './theme';

installDom();

const ports = (): ThemePorts & {
  attributes: Record<string, string>;
  flip: (dark: boolean) => void;
} => {
  const attributes: Record<string, string> = {};
  const listeners = new Set<() => void>();
  const query: DarkQuery & { matches: boolean } = {
    matches: false,
    addEventListener: (_type, listener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener) => {
      listeners.delete(listener);
    },
  };
  const data: Record<string, string> = {};
  const storage: KeyValueStorage = {
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
  return {
    attributes,
    storage,
    query,
    target: {
      setAttribute: (name, value): void => {
        attributes[name] = value;
      },
    },
    flip: (dark): void => {
      query.matches = dark;
      for (const listener of listeners) listener();
    },
  };
};

const Probe = (): React.JSX.Element => {
  const { choice, resolved, setChoice } = useTheme();
  return (
    <button
      type="button"
      onClick={() => {
        setChoice('dark');
      }}
    >
      {choice}/{resolved}
    </button>
  );
};

describe('ThemeProvider and useTheme', () => {
  test('a component reads the choice and what it resolves to, and can change it', () => {
    const fake = ports();
    const { getByRole } = render(
      <ThemeProvider ports={fake}>
        <Probe />
      </ThemeProvider>,
    );
    expect(getByRole('button').textContent).toBe('system/light');
    act(() => {
      getByRole('button').click();
    });
    expect(getByRole('button').textContent).toBe('dark/dark');
    expect(fake.attributes['data-theme']).toBe('dark');
  });

  test('re-renders when the operating system changes and the choice is system', () => {
    const fake = ports();
    const { getByRole } = render(
      <ThemeProvider ports={fake}>
        <Probe />
      </ThemeProvider>,
    );
    act(() => {
      fake.flip(true);
    });
    expect(getByRole('button').textContent).toBe('system/dark');
  });

  // StrictMode runs every effect, its cleanup, and the effect again — what React does to a provider
  // it unmounts and brings back with its state kept. A cleanup that stopped the store from writing
  // the page, with nothing to start it again, left the choice made and the page unchanged.
  test('a choice still reaches the page after the effects have been cleaned up and run again', () => {
    const fake = ports();
    const { getByRole } = render(
      <StrictMode>
        <ThemeProvider ports={fake}>
          <Probe />
        </ThemeProvider>
      </StrictMode>,
    );
    act(() => {
      getByRole('button').click();
    });
    expect(getByRole('button').textContent).toBe('dark/dark');
    expect(fake.attributes['data-theme']).toBe('dark');
  });

  test('the operating system is still followed after the effects have been cleaned up and run again', () => {
    const fake = ports();
    const { getByRole } = render(
      <StrictMode>
        <ThemeProvider ports={fake}>
          <Probe />
        </ThemeProvider>
      </StrictMode>,
    );
    act(() => {
      fake.flip(true);
    });
    expect(getByRole('button').textContent).toBe('system/dark');
    expect(fake.attributes['data-theme']).toBe('dark');
  });

  test('uses the browser when given no ports', () => {
    const { getByRole, unmount } = render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    expect(getByRole('button').textContent).toMatch(/^system\/(light|dark)$/);
    expect(['light', 'dark']).toContain(document.documentElement.getAttribute('data-theme') ?? '');
    unmount();
  });

  test('the hook refuses to work without a provider, and says so', () => {
    // React logs the render error it is about to throw; the test asserts the throw.
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Probe />)).toThrow('useTheme needs a <ThemeProvider>');
    } finally {
      logged.mockRestore();
    }
  });
});
