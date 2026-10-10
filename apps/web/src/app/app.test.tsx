/**
 * The application frame, rendered through the real provider tree.
 *
 * What is asserted is what a keyboard and a screen-reader user need from a
 * single-page application: a skip link first, one `<main>`, focus that follows a
 * navigation, a page that is never blank while the words load, and a gallery that
 * is not reachable unless it was asked for.
 */
import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { App } from './app';
import { Outlet } from './outlet';
import { AppSkeleton } from './skeleton';
import { AppProviders } from './providers';
import { fakeColourScheme, fakeHistory, fakeSchedule, memoryStorage } from '../testing/fakes';
import { en } from '../i18n/catalogue/en';

installDom();

const worldPorts = (
  path: string,
  load: () => Promise<typeof en> = () => Promise.resolve(en),
): Parameters<typeof App>[0] => ({
  ports: {
    theme: {
      storage: memoryStorage(),
      query: fakeColourScheme(false),
      target: { setAttribute: () => undefined },
    },
    i18n: {
      storage: memoryStorage(),
      languages: ['en'],
      load,
      target: { setAttribute: () => undefined },
      timeZone: 'UTC',
    },
    history: fakeHistory(path),
    schedule: fakeSchedule().schedule,
  },
});

const mounted = async (path: string): Promise<ReturnType<typeof render>> => {
  const result = render(<App {...worldPorts(path)} />);
  await act(async () => {
    await Promise.resolve();
  });
  return result;
};

describe('the frame', () => {
  test('has a skip link first, and one main that it points at', async () => {
    const { getByRole, container } = await mounted('/');
    const skip = getByRole('link', { name: 'Skip to the conversation' });
    expect(container.querySelector('a') === skip).toBe(true);
    const main = getByRole('main');
    expect(skip.getAttribute('href')).toBe(`#${main.id}`);
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  test('has its toast region ready before any toast', async () => {
    const { getByRole } = await mounted('/');
    expect(getByRole('status')).toBeDefined();
  });

  test('passes the accessibility audit on every known route', async () => {
    for (const path of [
      '/',
      '/sign-in',
      '/w/acme',
      '/w/acme/c/c1',
      '/w/acme/questions',
      '/nowhere',
    ]) {
      const { container, unmount } = await mounted(path);
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});

describe('what an address shows', () => {
  test.each(['/', '/sign-in', '/w/acme', '/w/acme/c/c1', '/w/acme/questions'])(
    '%s is a screen that is not built yet, and says so',
    async (path) => {
      const { getByRole } = await mounted(path);
      expect(
        getByRole('heading', { level: 1, name: 'This screen is not built yet' }),
      ).toBeDefined();
    },
  );

  test('an address that is not a route is not found, and offers the way home', async () => {
    const { getByRole } = await mounted('/nowhere');
    expect(getByRole('heading', { level: 1, name: 'Nothing here' })).toBeDefined();
    expect(getByRole('link', { name: 'Go to your channels' }).getAttribute('href')).toBe('/');
  });

  test('the gallery is not reachable in a build that does not have it', async () => {
    const { getByRole } = await mounted('/__gallery');
    expect(getByRole('heading', { level: 1, name: 'Nothing here' })).toBeDefined();
  });
});

describe('focus follows navigation', () => {
  test('is not moved on first render, where the browser has already done it', async () => {
    await mounted('/');
    expect(document.activeElement === document.body).toBe(true);
  });

  test('moves to main when the address changes', async () => {
    const { getByRole } = await mounted('/nowhere');
    const link = getByRole('link', { name: 'Go to your channels' });
    act(() => {
      link.focus();
    });
    fireEvent.click(link);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement === getByRole('main')).toBe(true);
  });
});

describe('the gallery route', () => {
  test('shows the gallery when the build has it, behind a loading state', async () => {
    const Stub = (): React.JSX.Element => <h1>stub gallery</h1>;
    const { findByRole } = await renderApp(<Outlet gallery={Stub} />, { path: '/__gallery' });
    expect(await findByRole('heading', { name: 'stub gallery' })).toBeDefined();
  });

  test('shows a loading state while a lazy gallery loads', async () => {
    const { lazy } = await import('react');
    let release: (module: { default: () => React.JSX.Element }) => void = () => undefined;
    const Slow = lazy(
      () =>
        new Promise<{ default: () => React.JSX.Element }>((resolve) => {
          release = resolve;
        }),
    );
    const { getByRole, findByRole } = await renderApp(<Outlet gallery={Slow} />, {
      path: '/__gallery',
    });
    expect(getByRole('status').textContent).toBe('Loading');
    await act(async () => {
      release({ default: () => <h1>arrived</h1> });
      await Promise.resolve();
    });
    expect(await findByRole('heading', { name: 'arrived' })).toBeDefined();
  });
});

describe('the skeleton', () => {
  test('is shown while the words load, hidden from assistive technology', async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<typeof en>((resolve) => {
      release = (): void => {
        resolve(en);
      };
    });
    const { container, queryByRole } = render(<App {...worldPorts('/', () => slow)} />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(queryByRole('main')).toBeNull();
    await act(async () => {
      release();
      await slow;
    });
    expect(queryByRole('main')).not.toBeNull();
  });

  test('uses the same width tokens as the real frame, and holds no words', () => {
    const { container } = render(<AppSkeleton />);
    expect(container.textContent).toBe('');
    expect(container.innerHTML).toContain('w-sidebar');
    expect(container.innerHTML).toContain('h-header');
  });
});

describe('AppProviders', () => {
  test('keeps one query cache for the life of the page', async () => {
    let seen: unknown[] = [];
    const { useQueryClient } = await import('@tanstack/react-query');
    const Probe = (): null => {
      seen = [...seen, useQueryClient()];
      return null;
    };
    const world = worldPorts('/');
    const { rerender } = render(
      <AppProviders {...(world.ports === undefined ? {} : { ports: world.ports })}>
        <Probe />
      </AppProviders>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender(
      <AppProviders {...(world.ports === undefined ? {} : { ports: world.ports })}>
        <Probe />
      </AppProviders>,
    );
    expect(new Set(seen).size).toBe(1);
  });
});
