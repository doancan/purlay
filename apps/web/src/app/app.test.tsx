/**
 * The application frame, rendered through the real provider tree.
 *
 * What is asserted is what a keyboard and a screen-reader user need from a
 * single-page application: a skip link first, one `<main>`, focus that follows a
 * navigation, a page that is never blank while the words load, and a gallery that
 * is not reachable unless it was asked for.
 */
import { installDom } from '../testing/dom';
import { StrictMode } from 'react';
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { App } from './app';
import { Outlet, loadGallery } from './outlet';
import { Gallery } from '../gallery/gallery';
import { AppSkeleton } from './skeleton';
import { AppProviders } from './providers';
import { fakeColourScheme, fakeHistory, fakeSchedule, memoryStorage } from '../testing/fakes';
import { en } from '../i18n/catalogue/en';
import { ApiError } from '../data/errors';
import type { Api } from '../data/api';
import { anApi } from '../testing/fake-api';
import { IDS, aSignedInApi } from '../testing/fixtures';
import { expectFocusOn } from '../testing/focus';
import { NarrowPortContext, type NarrowPort } from '../features/shell/narrow';

installDom();

const signedIn = (): Api => aSignedInApi();

/** Nobody is signed in: the identity answers 401, as the API does. */
const signedOut = (): Api =>
  anApi({ me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in.')) });

const worldPorts = (
  path: string,
  load: () => Promise<typeof en> = () => Promise.resolve(en),
  api: Api = signedOut(),
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
    api,
  },
});

/** Lets queries answer and the redirects they cause land: a few turns of the event loop. */
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const mounted = async (path: string, api?: Api): Promise<ReturnType<typeof render>> => {
  const result = render(<App {...worldPorts(path, undefined, api)} />);
  await settle();
  return result;
};

describe('the frame', () => {
  test('has a skip link first, and one main that it points at', async () => {
    const { getByRole, container } = await mounted('/sign-in');
    const skip = getByRole('link', { name: 'Skip to the conversation' });
    expect(container.querySelector('a') === skip).toBe(true);
    const main = getByRole('main');
    expect(skip.getAttribute('href')).toBe(`#${main.id}`);
    expect(main.getAttribute('tabindex')).toBe('-1');
  });

  test('has its toast region ready before any toast', async () => {
    const { getByRole } = await mounted('/sign-in');
    expect(getByRole('status')).toBeDefined();
  });

  test('passes the accessibility audit on every known route, signed out and signed in', async () => {
    for (const path of ['/sign-in', '/nowhere']) {
      const { container, unmount } = await mounted(path);
      await expectNoAxeViolations(container);
      unmount();
    }
    for (const path of ['/w/acme', `/w/acme/c/${IDS.api}`, '/w/acme/questions']) {
      const { container, unmount } = await mounted(path, aSignedInApi());
      await expectNoAxeViolations(container);
      unmount();
    }
  });
});

describe('what an address shows', () => {
  test('/sign-in is the sign-in screen', async () => {
    const { getByRole } = await mounted('/sign-in');
    expect(getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toBeDefined();
  });

  test.each(['/', '/w/acme', `/w/acme/c/${IDS.api}`, '/w/acme/questions'])(
    '%s asks a signed-out visitor to sign in',
    async (path) => {
      const { getByRole } = await mounted(path);
      expect(getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toBeDefined();
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
    await mounted('/sign-in');
    expectFocusOn(document.body);
  });

  // StrictMode runs the frame's effect, its cleanup, and the effect again on the first render, with
  // the address unchanged. Counting runs took the second for a navigation, and the first Tab on
  // the page then went past the skip link from a focused main.
  test('is not moved on first render when the effect runs twice for one address', async () => {
    render(
      <StrictMode>
        <App {...worldPorts('/sign-in')} />
      </StrictMode>,
    );
    await settle();
    expectFocusOn(document.body);
  });

  test('moves to main when the address changes, with the effects run twice', async () => {
    const { getByRole } = render(
      <StrictMode>
        <App {...worldPorts('/nowhere')} />
      </StrictMode>,
    );
    await settle();
    expectFocusOn(document.body);
    fireEvent.click(getByRole('link', { name: 'Go to your channels' }));
    await settle();
    expectFocusOn(getByRole('main'));
  });

  test('moves to main when the address changes', async () => {
    const { getByRole } = await mounted('/nowhere');
    const link = getByRole('link', { name: 'Go to your channels' });
    act(() => {
      link.focus();
    });
    fireEvent.click(link);
    await settle();
    expectFocusOn(getByRole('main'));
  });

  /** A window on one side of the narrow line, for as long as the test runs. */
  const windowThat =
    (narrow: boolean): NarrowPort =>
    () => ({
      matches: narrow,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    });

  test('reaches a main that was not there yet when the address changed', async () => {
    // `/` asks who is signed in before it has a page, so the first thing it shows has no <main>.
    // A narrow window, where nothing on the page keeps focus from it (#697).
    const { getByRole } = render(
      <NarrowPortContext.Provider value={windowThat(true)}>
        <App {...worldPorts('/nowhere', undefined, signedIn())} />
      </NarrowPortContext.Provider>,
    );
    await settle();
    fireEvent.click(getByRole('link', { name: 'Go to your channels' }));
    await settle();
    expectFocusOn(getByRole('main'));
  });

  test('on a wide window, leaves focus in the composer of the channel it arrives in (#697)', async () => {
    const { getByRole } = render(
      <NarrowPortContext.Provider value={windowThat(false)}>
        <App {...worldPorts('/nowhere', undefined, signedIn())} />
      </NarrowPortContext.Provider>,
    );
    await settle();
    fireEvent.click(getByRole('link', { name: 'Go to your channels' }));
    await settle();
    expectFocusOn(getByRole('textbox', { name: 'Message api' }));
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

describe('the gallery chunk', () => {
  test('loads as the gallery, so the build flag only decides whether anything asks for it', async () => {
    expect((await loadGallery()).default).toBe(Gallery);
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
    const { container, queryByRole } = render(<App {...worldPorts('/sign-in', () => slow)} />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
    expect(queryByRole('main')).toBeNull();
    await act(async () => {
      release();
      await slow;
    });
    await settle();
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
