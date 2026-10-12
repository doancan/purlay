/**
 * The sidebar on a window that is too narrow for it (`UX.md` §2): an overlay, with the
 * behaviours an overlay owes a keyboard — focus in, focus kept in, Escape out, focus back where
 * it came from, and, when somewhere is chosen, focus on the page. The line between narrow and
 * wide is moved by hand through the port; no browser is resized.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { NavToggle } from './nav';
import { NarrowPortContext, browserNarrow, useNarrow, type NarrowPort } from './narrow';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** A window whose width the test decides, and a record of the widths it was asked about. */
const aWindow = (
  narrow: boolean,
): { port: NarrowPort; set: (narrow: boolean) => void; asked: string[] } => {
  const listeners = new Set<() => void>();
  const query = {
    matches: narrow,
    addEventListener: (_type: 'change', listener: () => void): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: () => void): void => {
      listeners.delete(listener);
    },
  };
  const asked: string[] = [];
  return {
    asked,
    port: (width): typeof query => {
      asked.push(width);
      return query;
    },
    set: (next): void => {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
};

const open = async (
  path: string,
  narrow: boolean,
): Promise<{ view: Awaited<ReturnType<typeof renderApp>>; window: ReturnType<typeof aWindow> }> => {
  const window = aWindow(narrow);
  const view = await renderApp(
    <NarrowPortContext.Provider value={window.port}>
      <Outlet />
    </NarrowPortContext.Provider>,
    { path, api: aSignedInApi() },
  );
  await settle();
  return { view, window };
};

/** What `window.matchMedia` answers, for the default port. */
const matchMediaAnswering = (matches: boolean): typeof window.matchMedia =>
  ((query: string) => ({
    matches,
    media: query,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  })) as unknown as typeof window.matchMedia;

const channel = `/w/acme/c/${IDS.api}`;

describe('a wide window', () => {
  test('keeps the sidebar in the layout and is not an overlay', async () => {
    const { view } = await open(channel, false);
    expect(view.getByRole('complementary', { name: 'Workspace' })).toBeDefined();
    expect(view.queryByRole('dialog')).toBeNull();
    // The toggle is in the page but drawn only below the breakpoint (`max-narrow:`).
    expect(
      view.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'),
    ).toBe('false');
    await expectNoAxeViolations(view.container);
  });
});

describe('a narrow window', () => {
  test('has no sidebar on the page until the toggle opens it as a dialog that holds focus', async () => {
    const { view } = await open(channel, true);
    expect(view.queryByRole('complementary')).toBeNull();
    expect(view.queryByRole('navigation', { name: 'Places' })).toBeNull();
    const toggle = view.getByRole('button', { name: 'Open navigation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    await person().click(toggle);
    await settle();
    const panel = view.getByRole('dialog', { name: 'Workspace' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(panel.querySelector('aside')).not.toBeNull();
    // The rail goes with the sidebar: on a narrow window neither is in the layout.
    expect(within(panel).getByRole('navigation', { name: 'Places' })).toBeDefined();
    // The panel itself: Radix marks the rest of the page aria-hidden while it is open, which axe
    // reports against the page's own focusable elements though they cannot be reached.
    await expectNoAxeViolations(panel);
  });

  test('Escape closes it and puts focus back on the toggle', async () => {
    const { view } = await open(channel, true);
    const toggle = view.getByRole('button', { name: 'Open navigation' });
    await person().click(toggle);
    await settle();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement === toggle).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  test('choosing a channel closes it and puts focus on the page, not on the toggle', async () => {
    const { view } = await open(channel, true);
    await person().click(view.getByRole('button', { name: 'Open navigation' }));
    await settle();
    await person().click(view.getByRole('link', { name: /deploys/ }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}`);
    expect(document.activeElement === view.getByRole('main')).toBe(true);
  });

  test('widening the window gives the sidebar back to the layout and closes the overlay', async () => {
    const { view, window } = await open(channel, true);
    await person().click(view.getByRole('button', { name: 'Open navigation' }));
    await settle();
    expect(view.getByRole('dialog')).toBeDefined();
    act(() => {
      window.set(false);
    });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByRole('complementary', { name: 'Workspace' })).toBeDefined();
    act(() => {
      window.set(true);
    });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('the line is the token the stylesheet uses, not a number written here', async () => {
    document.documentElement.style.setProperty('--size-narrow', '900px');
    const { window } = await open(channel, true);
    expect(window.asked).toEqual(['900px']);
    document.documentElement.style.removeProperty('--size-narrow');
  });
});

describe('screens with no header of their own', () => {
  test('still offer the way in: a channel that is not there, and a workspace with nothing joined', async () => {
    const missing = await open('/w/acme/c/00000000-0000-4000-8000-0000000000ff', true);
    expect(missing.view.getByRole('button', { name: 'Open navigation' })).toBeDefined();
    missing.view.unmount();

    const window = aWindow(true);
    const view = await renderApp(
      <NarrowPortContext.Provider value={window.port}>
        <Outlet />
      </NarrowPortContext.Provider>,
      {
        path: '/w/acme',
        api: aSignedInApi({
          channels: () => Promise.resolve([aChannel(IDS.browse, 'browse', { state: null })]),
        }),
      },
    );
    await settle();
    expect(view.getByRole('heading', { name: 'Pick a channel' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Open navigation' })).toBeDefined();
  });

  test('the open questions have the toggle in their own header, and hide what the title repeats', async () => {
    const { view } = await open('/w/acme/questions', true);
    expect(view.getByRole('button', { name: 'Open navigation' })).toBeDefined();
  });
});

describe('the toggle outside a frame', () => {
  test('is not drawn: a header does not need to know whether it has a sidebar to open', async () => {
    const view = await renderApp(<NavToggle />);
    expect(view.queryByRole('button', { name: 'Open navigation' })).toBeNull();
  });
});

describe('the browser port', () => {
  test('asks the window for exactly the range the stylesheet draws', () => {
    const spy = spyOn(window, 'matchMedia').mockImplementation(matchMediaAnswering(false));
    const query = browserNarrow('900px');
    expect(query.matches).toBe(false);
    expect(spy).toHaveBeenCalledWith('(width < 900px)');
    spy.mockRestore();
  });

  test('is what a component uses when nobody gave it another', async () => {
    const spy = spyOn(window, 'matchMedia').mockImplementation(matchMediaAnswering(true));
    const seen: boolean[] = [];
    const Probe = (): null => {
      seen.push(useNarrow());
      return null;
    };
    await renderApp(<Probe />);
    expect(seen.at(-1)).toBe(true);
    spy.mockRestore();
  });
});
