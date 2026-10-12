import { installDom } from '../testing/dom';
import { describe, expect, spyOn, test } from 'bun:test';
import { Component } from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { en } from './catalogue/en';
import { tr } from './catalogue/tr';
import { I18nProvider, useI18n, type I18nPorts } from './i18n-provider';
import { LOCALE_KEY } from './locale';
import type { Catalogue, Locale } from './types';

installDom();

/** Ports whose catalogue loads are released by hand, so a test can look at the wait. */
const ports = (
  overrides: Partial<I18nPorts> = {},
): I18nPorts & {
  attributes: Record<string, string>;
  data: Record<string, string>;
  release: (locale: Locale) => void;
  /** The catalogue's chunk did not arrive: a build that has gone (#334), or the network. */
  fail: (locale: Locale) => void;
  asked: Locale[];
} => {
  const attributes: Record<string, string> = {};
  const data: Record<string, string> = {};
  const waiting = new Map<Locale, (catalogue: Catalogue) => void>();
  const refusing = new Map<Locale, (failure: Error) => void>();
  const asked: Locale[] = [];
  return {
    attributes,
    data,
    asked,
    storage: {
      getItem: (key): string | null => data[key] ?? null,
      setItem: (key, value): void => {
        data[key] = value;
      },
    },
    languages: ['en-US'],
    timeZone: 'UTC',
    target: {
      setAttribute: (name, value): void => {
        attributes[name] = value;
      },
    },
    load: (locale) =>
      new Promise<Catalogue>((resolve, reject) => {
        asked.push(locale);
        waiting.set(locale, resolve);
        refusing.set(locale, reject);
      }),
    release: (locale): void => {
      waiting.get(locale)?.(locale === 'tr' ? tr : en);
    },
    fail: (locale): void => {
      refusing.get(locale)?.(new Error(`the ${locale} chunk did not arrive`));
    },
    ...overrides,
  };
};

const Probe = (): React.JSX.Element => {
  const { t, locale, setLocale, format } = useI18n();
  return (
    <div>
      <p>{t('common.close')}</p>
      <p data-testid="locale">{locale}</p>
      <p data-testid="time">{format.number(1234)}</p>
      <button
        type="button"
        onClick={() => {
          setLocale('tr');
        }}
      >
        switch
      </button>
    </div>
  );
};

describe('I18nProvider', () => {
  test('shows the fallback until the first catalogue has loaded, never the wrong language', async () => {
    const fake = ports();
    const { queryByText, getByText } = render(
      <I18nProvider ports={fake} fallback={<p>skeleton</p>}>
        <Probe />
      </I18nProvider>,
    );
    expect(getByText('skeleton')).toBeDefined();
    expect(queryByText('Close')).toBeNull();
    act(() => {
      fake.release('en');
    });
    await waitFor(() => {
      expect(getByText('Close')).toBeDefined();
    });
    expect(fake.attributes['lang']).toBe('en');
  });

  test('starts in the browser’s language when nothing was chosen', async () => {
    const fake = ports({ languages: ['tr-TR'] });
    const { getByText } = render(
      <I18nProvider ports={fake}>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      fake.release('tr');
    });
    await waitFor(() => {
      expect(getByText('Kapat')).toBeDefined();
    });
    expect(fake.asked).toEqual(['tr']);
  });

  test('switching keeps the old words until the new catalogue arrives, then remembers the choice', async () => {
    const fake = ports();
    const { getByText, getByRole, getByTestId } = render(
      <I18nProvider ports={fake}>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      fake.release('en');
    });
    await waitFor(() => {
      expect(getByText('Close')).toBeDefined();
    });
    act(() => {
      getByRole('button').click();
    });
    // Still English, still `en`, while Turkish is on its way.
    expect(getByText('Close')).toBeDefined();
    expect(getByTestId('locale').textContent).toBe('en');
    // Not remembered yet: a language whose words never came must not be the next visit's.
    expect(fake.data[LOCALE_KEY]).toBeUndefined();
    act(() => {
      fake.release('tr');
    });
    await waitFor(() => {
      expect(getByText('Kapat')).toBeDefined();
    });
    expect(getByTestId('locale').textContent).toBe('tr');
    expect(getByTestId('time').textContent).toBe('1.234');
    expect(fake.attributes['lang']).toBe('tr');
    expect(fake.data[LOCALE_KEY]).toBe('tr');
  });

  test('a catalogue that does not arrive leaves the page in its language, not remembered, and a later try can work', async () => {
    const fake = ports();
    const { getByText, getByRole, getByTestId } = render(
      <I18nProvider ports={fake}>
        <Probe />
      </I18nProvider>,
    );
    act(() => {
      fake.release('en');
    });
    await waitFor(() => {
      expect(getByText('Close')).toBeDefined();
    });
    act(() => {
      getByRole('button').click();
    });
    await act(async () => {
      fake.fail('tr');
      await Promise.resolve();
    });
    expect(getByTestId('locale').textContent).toBe('en');
    expect(fake.data[LOCALE_KEY]).toBeUndefined();
    expect(fake.attributes['lang']).toBe('en');
    act(() => {
      getByRole('button').click();
    });
    act(() => {
      fake.release('tr');
    });
    await waitFor(() => {
      expect(getByText('Kapat')).toBeDefined();
    });
  });

  test('a remembered language that does not arrive at the start falls back to English', async () => {
    const fake = ports();
    fake.data[LOCALE_KEY] = 'tr';
    const { getByText } = render(
      <I18nProvider ports={fake} fallback={<p>skeleton</p>}>
        <Probe />
      </I18nProvider>,
    );
    await act(async () => {
      fake.fail('tr');
      await Promise.resolve();
    });
    act(() => {
      fake.release('en');
    });
    await waitFor(() => {
      expect(getByText('Close')).toBeDefined();
    });
    expect(fake.asked).toEqual(['tr', 'en']);
  });

  test('English not arriving at the start is said, loudly, not a page left on its skeleton', async () => {
    const fake = ports();
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    let caught: unknown = null;
    class Catch extends Component<{ children: React.ReactNode }, { failed: boolean }> {
      override state = { failed: false };
      static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
      }
      override componentDidCatch(error: unknown): void {
        caught = error;
      }
      override render(): React.ReactNode {
        return this.state.failed ? <p>caught</p> : this.props.children;
      }
    }
    const { getByText } = render(
      <Catch>
        <I18nProvider ports={fake} fallback={<p>skeleton</p>}>
          <Probe />
        </I18nProvider>
      </Catch>,
    );
    await act(async () => {
      fake.fail('en');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(getByText('caught')).toBeDefined();
    });
    expect(String(caught)).toContain('the en chunk did not arrive');
    quiet.mockRestore();
  });

  test('a catalogue that arrives after the page moved on is ignored', async () => {
    const fake = ports();
    const { getByText, unmount } = render(
      <I18nProvider ports={fake}>
        <Probe />
      </I18nProvider>,
    );
    unmount();
    act(() => {
      fake.release('en');
    });
    await Promise.resolve();
    expect(fake.attributes['lang']).toBeUndefined();
    expect(() => getByText('Close')).toThrow();
  });

  test('uses the browser and the real chunks when given no ports', async () => {
    const { findByText } = render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(await findByText(/^(Close|Kapat)$/)).toBeDefined();
    expect(['en', 'tr']).toContain(document.documentElement.getAttribute('lang') ?? '');
  });

  test('the hook refuses to work without a provider', () => {
    const logged = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => render(<Probe />)).toThrow('useI18n needs an <I18nProvider>');
    } finally {
      logged.mockRestore();
    }
  });
});
