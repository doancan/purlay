import { installDom } from '../testing/dom';
import { describe, expect, spyOn, test } from 'bun:test';
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
  asked: Locale[];
} => {
  const attributes: Record<string, string> = {};
  const data: Record<string, string> = {};
  const waiting = new Map<Locale, (catalogue: Catalogue) => void>();
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
      new Promise<Catalogue>((resolve) => {
        asked.push(locale);
        waiting.set(locale, resolve);
      }),
    release: (locale): void => {
      waiting.get(locale)?.(locale === 'tr' ? tr : en);
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
    expect(fake.data[LOCALE_KEY]).toBe('tr');
    act(() => {
      fake.release('tr');
    });
    await waitFor(() => {
      expect(getByText('Kapat')).toBeDefined();
    });
    expect(getByTestId('locale').textContent).toBe('tr');
    expect(getByTestId('time').textContent).toBe('1.234');
    expect(fake.attributes['lang']).toBe('tr');
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
