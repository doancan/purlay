/**
 * The door to the deferred chunk (D-163): an overlay is not drawn before the chunk arrives and stays
 * drawn after; a chunk that does not arrive says so once, puts the overlay's `open` back, and is
 * asked for again by the next request; and the shell's preload asks for it when the browser is idle,
 * or after a while where there is no idle callback, and not at all once the shell is gone.
 *
 * **How the chunk is made not to arrive** is the image viewer's door's way (its test says why): the
 * module is taken out of the registry and mocked with one that fails to load, then with the real
 * module's own exports. The door is a fresh copy (`?offline`), so the one the rest of the suite uses
 * keeps the chunk it already has, and this one starts without it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act } from '@testing-library/react';
import { useState } from 'react';
import { settle } from '../testing/channel-harness';
import { installDom } from '../testing/dom';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { Toaster } from '../ui/toast';
import type * as DoorModule from './deferred-door';

installDom();

const DEFERRED = './deferred';
const UNAVAILABLE = 'That did not open. Check your connection and try again.';

// Its exports, held apart from the module: a mock replaces what the module's own record holds.
const real = { ...(await import('./deferred')) };
const PATH = require.resolve(DEFERRED);

let attempts = 0;

const failNextLoad = async (): Promise<void> => {
  Reflect.deleteProperty(require.cache, PATH);
  await mock.module(DEFERRED, () => {
    attempts += 1;
    throw new TypeError('Failed to fetch dynamically imported module');
  });
};

const goOnline = async (): Promise<void> => {
  Reflect.deleteProperty(require.cache, PATH);
  await mock.module(DEFERRED, () => real);
};

let door: typeof DoorModule;

beforeAll(async () => {
  const fresh = 'offline';
  door = (await import(`./deferred-door?${fresh}`)) as typeof DoorModule;
});

afterAll(goOnline);

/** A button that opens the shortcut reference through the door, as the shell's overlays do. */
const Opener = (): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const deferred = door.useDeferred([open, setOpen]);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Shortcuts
      </button>
      <span>{open ? 'wanted' : 'not wanted'}</span>
      {deferred !== null && <deferred.ShortcutsDialog open={open} mac onOpenChange={setOpen} />}
    </>
  );
};

describe('an overlay behind the door', () => {
  test('says once that it did not open, puts its open back, and opens on the next request', async () => {
    const view = await renderApp(
      <>
        <Toaster dismissLabel="Dismiss" />
        <Opener />
      </>,
    );
    const button = view.getByRole('button', { name: 'Shortcuts' });

    await failNextLoad();
    await person().click(button);
    await settle();
    expect(attempts).toBe(1);
    expect(view.getAllByText(UNAVAILABLE)).toHaveLength(1);
    expect(view.getByText('not wanted')).toBeDefined();
    expect(view.queryByRole('dialog')).toBeNull();

    // The failure is not remembered: the next click asks again, and the reference opens.
    await goOnline();
    await person().click(button);
    await settle();
    expect(view.getByRole('dialog')).toBeDefined();

    // It closes as a dialog closes, and opens again at once: the chunk is not asked for twice.
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    const asked = attempts;
    await person().click(button);
    expect(view.getByRole('dialog')).toBeDefined();
    expect(attempts).toBe(asked);
    view.unmount();
  });

  test('is drawn at once by a door mounted after the chunk arrived', async () => {
    await door.loadDeferred();
    const view = await renderApp(<Opener />);
    await person().click(view.getByRole('button', { name: 'Shortcuts' }));
    // No round of waiting: the module is already there, so the first draw has the dialog.
    expect(view.getByRole('dialog')).toBeDefined();
    view.unmount();
  });
});

describe('the preload', () => {
  // A copy of its own, which has not fetched the chunk yet: the overlays above already have.
  let preloading: typeof DoorModule;
  beforeAll(async () => {
    const fresh = 'idle';
    preloading = (await import(`./deferred-door?${fresh}`)) as typeof DoorModule;
  });

  const Preloader = (): null => {
    preloading.usePreloadDeferred();
    return null;
  };

  const idle: { callback: (() => void) | null; cancelled: number[] } = {
    callback: null,
    cancelled: [],
  };

  const installIdle = (): void => {
    Object.assign(window, {
      requestIdleCallback: (callback: () => void, options: { timeout: number }): number => {
        expect(options.timeout).toBeGreaterThan(0);
        idle.callback = callback;
        return 7;
      },
      cancelIdleCallback: (handle: number): void => {
        idle.cancelled.push(handle);
      },
    });
  };

  afterEach(() => {
    Reflect.deleteProperty(window, 'requestIdleCallback');
    Reflect.deleteProperty(window, 'cancelIdleCallback');
    idle.callback = null;
    idle.cancelled = [];
  });

  test('asks for the chunk when the browser is idle, and a failure there says nothing', async () => {
    installIdle();
    const view = await renderApp(
      <>
        <Toaster dismissLabel="Dismiss" />
        <Preloader />
      </>,
    );
    expect(idle.callback).not.toBeNull();
    await failNextLoad();
    const before = attempts;
    act(() => {
      idle.callback?.();
    });
    await settle();
    expect(attempts).toBe(before + 1);
    expect(view.queryByText(UNAVAILABLE)).toBeNull();
    await goOnline();
    view.unmount();
  });

  test('is called off when the shell goes before the browser is idle', async () => {
    installIdle();
    const view = await renderApp(<Preloader />);
    view.unmount();
    expect(idle.cancelled).toEqual([7]);
  });

  test('without an idle callback, waits a while and then asks', async () => {
    const timers: { delay: number; cleared: boolean }[] = [];
    const setTimer = window.setTimeout.bind(window);
    const clearTimer = window.clearTimeout.bind(window);
    // Own properties or not, as they were: happy-dom may define them on the prototype.
    const saved = {
      setTimeout: Object.getOwnPropertyDescriptor(window, 'setTimeout'),
      clearTimeout: Object.getOwnPropertyDescriptor(window, 'clearTimeout'),
    };
    let fire: (() => void) | null = null;
    Object.assign(window, {
      setTimeout: (callback: () => void, delay: number): number => {
        // The preload's wait, told apart from the zero-delay turns React and the test helpers take.
        if (delay >= 1_000) {
          fire = callback;
          timers.push({ delay, cleared: false });
          return 99;
        }
        return setTimer(callback, delay);
      },
      clearTimeout: (handle: number): void => {
        if (handle === 99) {
          const last = timers.at(-1);
          if (last !== undefined) last.cleared = true;
        } else clearTimer(handle);
      },
    });
    try {
      const view = await renderApp(<Preloader />);
      expect(timers).toHaveLength(1);
      const asked = attempts;
      await failNextLoad();
      act(() => {
        fire?.();
      });
      await settle();
      expect(attempts).toBe(asked + 1);
      await goOnline();
      view.unmount();
      expect(timers[0]?.cleared).toBe(true);
    } finally {
      for (const name of ['setTimeout', 'clearTimeout'] as const) {
        const descriptor = saved[name];
        if (descriptor === undefined) Reflect.deleteProperty(window, name);
        else Object.defineProperty(window, name, descriptor);
      }
    }
  });
});
