/**
 * Notifications on this device (#78, D-126), as a person meets them in the account menu: offered
 * only where they can work, turned on and off with the server told, honoured on a later load only
 * for the person who turned them on here, and a clicked notice opening its conversation.
 *
 * The browser is a device of the test's own (`PushDevice`); the server is the fake API, so a call
 * nobody expected fails the test.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { PushSubscribeRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { StorageProvider } from '../../data/storage-provider';
import { Toaster } from '../../ui/toast';
import type { DeviceSubscription, PushDevice } from './device';
import type { Notifier } from './notifier';
import { PUSH_OWNER_KEY } from './push';

installDom();

const KEY = `B${'K'.repeat(86)}`;
const ROTATED = `B${'R'.repeat(86)}`;
const SUBSCRIPTION: DeviceSubscription = {
  endpoint: 'https://push.example.com/send/1',
  p256dh: `B${'P'.repeat(86)}`,
  auth: 'A'.repeat(22),
  serverKey: KEY,
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

interface DeviceOptions {
  readonly held?: DeviceSubscription | null;
  readonly permission?: NotificationPermission;
  /** What the person answers when asked. */
  readonly answer?: NotificationPermission;
  /** A step the browser itself fails. */
  readonly fails?: 'subscribe' | 'current' | 'unsubscribe';
  /** Holds subscribing until it resolves. */
  readonly slow?: Promise<void>;
}

interface FakeDevice {
  readonly device: PushDevice;
  readonly calls: string[];
  readonly click: (url: string) => void;
}

const aDevice = ({
  held = null,
  permission = 'default',
  answer = 'granted',
  fails,
  slow,
}: DeviceOptions = {}): FakeDevice => {
  const calls: string[] = [];
  const listeners = new Set<(url: string) => void>();
  let holding = held;
  let allowed = permission;
  const device: PushDevice = {
    permission: () => allowed,
    current: () =>
      fails === 'current'
        ? Promise.reject(new DOMException('no registration', 'InvalidStateError'))
        : Promise.resolve(holding),
    subscribe: async (serverKey) => {
      calls.push(`subscribe ${serverKey.slice(0, 2)}`);
      await slow;
      if (fails === 'subscribe') throw new DOMException('push service unreachable', 'AbortError');
      if (allowed === 'default') allowed = answer;
      if (allowed !== 'granted') return null;
      holding = { ...SUBSCRIPTION, serverKey };
      return holding;
    },
    unsubscribe: () => {
      calls.push('unsubscribe');
      if (fails === 'unsubscribe') {
        return Promise.reject(new DOMException('push service unreachable', 'AbortError'));
      }
      holding = null;
      return Promise.resolve();
    },
    onOpen: (listener) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
  return {
    device,
    calls,
    click: (url: string): void => {
      for (const listener of listeners) listener(url);
    },
  };
};

/** The server's side: what it was sent, in order. */
const aServer = (overrides: Partial<Api> = {}): { api: Api; sent: unknown[] } => {
  const sent: unknown[] = [];
  const api = aSignedInApi({
    pushKey: () => Promise.resolve({ publicKey: KEY }),
    subscribePush: (input: PushSubscribeRequest) => {
      sent.push(['subscribe', input.endpoint, input.locale]);
      return Promise.resolve();
    },
    unsubscribePush: (endpoint) => {
      sent.push(['unsubscribe', endpoint]);
      return Promise.resolve();
    },
    setLocale: (locale) => {
      sent.push(['locale', locale]);
      return Promise.resolve();
    },
    ...overrides,
  });
  return { api, sent };
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (
  api: Api,
  device: PushDevice | null,
  options: { owner?: string; locale?: 'en' | 'tr' } = {},
): Promise<View> => {
  // The server's key waits until the browser's storage is as the test says, so the load is
  // judged against it.
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: `/w/acme/c/${IDS.api}`,
      api: {
        ...api,
        pushKey: async (signal) => {
          await ready;
          return await api.pushKey(signal);
        },
      },
      push: device,
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    },
  );
  if (options.owner !== undefined) view.world.storage.setItem(PUSH_OWNER_KEY, options.owner);
  release();
  await settle();
  return view;
};

const menu = async (view: View, name = 'Account: Dogancan'): Promise<void> => {
  await person().click(view.getByRole('button', { name }));
};

const items = (view: View): (string | null)[] =>
  view.getAllByRole('menuitem').map((item) => item.textContent);

describe('notifications on this device', () => {
  test('are not offered where the browser has no push, and the server is not asked', async () => {
    // `pushKey` is the fake API's refusal: a call fails the test.
    const view = await open(aSignedInApi(), null);
    await menu(view);
    expect(view.queryByText('Notifications on this device')).toBeNull();
    view.unmount();
  });

  test('nor where the browser keeps no storage to remember whose they are', async () => {
    const view = await renderApp(
      <StorageProvider storage={null}>
        <Outlet />
      </StorageProvider>,
      { path: `/w/acme/c/${IDS.api}`, api: aSignedInApi(), push: aDevice().device },
    );
    await settle();
    await menu(view);
    expect(view.queryByText('Notifications on this device')).toBeNull();
    view.unmount();
  });

  test('a key the server could not give is said', async () => {
    const { api } = aServer({
      pushKey: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    const view = await open(api, aDevice().device);
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    view.unmount();
  });

  test('nor where the server has them switched off', async () => {
    const { api } = aServer({
      pushKey: () => Promise.resolve({ publicKey: null }),
    });
    const view = await open(api, aDevice().device);
    await menu(view);
    expect(view.queryByText('Notifications on this device')).toBeNull();
    view.unmount();
  });

  test('turned on, ask the browser, tell the server in the person’s language, and remember whose', async () => {
    const { api, sent } = aServer();
    const browser = aDevice();
    const view = await open(api, browser.device, { locale: 'tr' });
    await menu(view, 'Hesap: Dogancan');
    expect(view.getByText('Bu cihazda bildirimler')).toBeDefined();
    await expectNoAxeViolations(view.getByRole('menu'));
    await person().click(view.getByRole('menuitem', { name: 'Aç' }));
    await settle();
    expect(browser.calls).toEqual(['subscribe BK']);
    expect(sent).toEqual([['subscribe', SUBSCRIPTION.endpoint, 'tr']]);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBe(IDS.me);
    await menu(view, 'Hesap: Dogancan');
    expect(items(view)).toContain('Kapat');
    view.unmount();
  });

  test('refused by the person, say where that is undone, and tell the server nothing', async () => {
    const { api, sent } = aServer();
    const view = await open(api, aDevice({ answer: 'denied' }).device);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn on' }));
    await settle();
    expect(sent).toEqual([]);
    await menu(view);
    const blocked = view.getByRole('menuitem', {
      name: 'Blocked: allow them in the browser’s site settings',
    });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');
    view.unmount();
  });

  test('refused by the server, stay off and say so', async () => {
    const { api } = aServer({
      subscribePush: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    const view = await open(api, aDevice().device);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn on' }));
    await settle();
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    // Not the person's here: the next load drops what the browser was left holding.
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });

  test('failed by the browser itself, tell the server nothing, stay off and say so', async () => {
    const { api, sent } = aServer();
    const view = await open(api, aDevice({ fails: 'subscribe' }).device);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn on' }));
    await settle();
    expect(sent).toEqual([]);
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });

  test('on their way, the switch says so and offers nothing until it is done', async () => {
    let finish = (): void => undefined;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const view = await open(aServer().api, aDevice({ slow }).device);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn on' }));
    await menu(view);
    expect(view.getByRole('menuitem', { name: 'One moment…' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(view.queryByRole('menuitem', { name: 'Turn on' })).toBeNull();
    await person().keyboard('{Escape}');
    finish();
    await settle();
    await menu(view);
    expect(items(view)).toContain('Turn off');
    view.unmount();
  });

  test('are reached and turned on from the keyboard', async () => {
    const browser = aDevice();
    const view = await open(aServer().api, browser.device);
    view.getByRole('button', { name: 'Account: Dogancan' }).focus();
    await person().keyboard('{Enter}');
    // Your profile, then Deep Work's four whiles, come first.
    await person().keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(document.activeElement?.textContent).toBe('Turn on');
    await person().keyboard('{Enter}');
    await settle();
    expect(browser.calls).toEqual(['subscribe BK']);
    view.unmount();
  });

  test('turned off, the server first and then the browser', async () => {
    const { api, sent } = aServer();
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'granted' });
    const view = await open(api, browser.device, { owner: IDS.me });
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn off' }));
    await settle();
    expect(sent.at(-1)).toEqual(['unsubscribe', SUBSCRIPTION.endpoint]);
    expect(browser.calls).toEqual(['unsubscribe']);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    view.unmount();
  });

  test('turned off by the server but not by the browser, it is off — nothing is sent — and says so', async () => {
    const { api, sent } = aServer();
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'granted', fails: 'unsubscribe' });
    const view = await open(api, browser.device, { owner: IDS.me });
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn off' }));
    await settle();
    expect(sent.at(-1)).toEqual(['unsubscribe', SUBSCRIPTION.endpoint]);
    // No owner: the next load drops what the browser kept.
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });

  test('turned off but refused by the server, stay on — the browser still told — and say so', async () => {
    const { api } = aServer({
      unsubscribePush: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'granted' });
    const view = await open(api, browser.device, { owner: IDS.me });
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn off' }));
    await settle();
    expect(browser.calls).toEqual([]);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBe(IDS.me);
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    await menu(view);
    expect(items(view)).toContain('Turn off');
    view.unmount();
  });
});

describe('on a later load', () => {
  test('the person who turned them on here is subscribed again, tied to this session', async () => {
    const { api, sent } = aServer();
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'granted' });
    const view = await open(api, browser.device, { owner: IDS.me });
    expect(sent).toEqual([['subscribe', SUBSCRIPTION.endpoint, 'en']]);
    expect(browser.calls).toEqual([]);
    view.unmount();
  });

  test('refused by the server, it is off and says so, rather than drawn on and not told', async () => {
    const { api } = aServer({
      subscribePush: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    const view = await open(api, aDevice({ held: SUBSCRIPTION, permission: 'granted' }).device, {
      owner: IDS.me,
    });
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });

  test('somebody else signed in on this browser finds them off, and the subscription dropped', async () => {
    const { api, sent } = aServer();
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'granted' });
    const view = await open(api, browser.device, { owner: IDS.alice });
    expect(sent).toEqual([]);
    expect(browser.calls).toEqual(['unsubscribe']);
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });

  test('a subscription made with a key the server replaced is made again, without asking', async () => {
    const { api, sent } = aServer({ pushKey: () => Promise.resolve({ publicKey: ROTATED }) });
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'granted' });
    const view = await open(api, browser.device, { owner: IDS.me });
    expect(browser.calls).toEqual(['subscribe BR']);
    expect(sent).toEqual([['subscribe', SUBSCRIPTION.endpoint, 'en']]);
    view.unmount();
  });

  test('a browser that refused is shown as blocked, and the server is not asked', async () => {
    const { api, sent } = aServer();
    const view = await open(api, aDevice({ permission: 'denied' }).device);
    await menu(view);
    expect(
      view.getByRole('menuitem', { name: 'Blocked: allow them in the browser’s site settings' }),
    ).toBeDefined();
    expect(sent).toEqual([]);
    view.unmount();
  });

  test('a browser that cannot say what it holds is off, and says so', async () => {
    const { api, sent } = aServer();
    const view = await open(api, aDevice({ fails: 'current' }).device, { owner: IDS.me });
    expect(sent).toEqual([]);
    expect(view.getByText(/^Notifications on this device were not changed\./)).toBeDefined();
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });

  test('a replaced key with the permission taken back since is blocked, and its leftover dropped', async () => {
    const { api, sent } = aServer({ pushKey: () => Promise.resolve({ publicKey: ROTATED }) });
    const browser = aDevice({ held: SUBSCRIPTION, permission: 'denied' });
    const view = await open(api, browser.device, { owner: IDS.me });
    expect(sent).toEqual([]);
    // Not made again only to be refused: the permission is read first (D-148).
    expect(browser.calls).toEqual(['unsubscribe']);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    await menu(view);
    expect(
      view.getByRole('menuitem', { name: 'Blocked: allow them in the browser’s site settings' }),
    ).toBeDefined();
    view.unmount();
  });

  test('a language the server could not be told is said, and told again with the next change', async () => {
    let refuse = true;
    const { api, sent } = aServer({
      setLocale: (locale) => {
        sent.push(['locale', locale]);
        return refuse ? Promise.reject(new ApiError(0, 'NETWORK', 'offline')) : Promise.resolve();
      },
    });
    const view = await open(api, aDevice({ held: SUBSCRIPTION, permission: 'granted' }).device, {
      owner: IDS.me,
    });
    await menu(view);
    await person().click(view.getByRole('menuitemradio', { name: 'Türkçe' }));
    await settle();
    expect(view.getByText(/^Bu cihazdaki bildirimler değiştirilemedi\./)).toBeDefined();
    refuse = false;
    await menu(view, 'Hesap: Dogancan');
    await person().click(view.getByRole('menuitemradio', { name: 'English' }));
    await settle();
    await menu(view);
    await person().click(view.getByRole('menuitemradio', { name: 'Türkçe' }));
    await settle();
    expect(sent.filter((call) => Array.isArray(call) && call[0] === 'locale')).toEqual([
      ['locale', 'tr'],
      ['locale', 'tr'],
    ]);
    view.unmount();
  });

  test('the language changed while on is told to the server, once', async () => {
    const { api, sent } = aServer();
    const view = await open(api, aDevice({ held: SUBSCRIPTION, permission: 'granted' }).device, {
      owner: IDS.me,
    });
    await menu(view);
    await person().click(view.getByRole('menuitemradio', { name: 'Türkçe' }));
    await settle();
    expect(sent).toEqual([
      ['subscribe', SUBSCRIPTION.endpoint, 'en'],
      ['locale', 'tr'],
    ]);
    view.unmount();
  });
});

test('a notice clicked opens its conversation in this tab', async () => {
  const browser = aDevice();
  const view = await open(aServer().api, browser.device);
  const path = `/w/acme/c/${IDS.deploys}`;
  act(() => {
    browser.click(path);
  });
  expect(view.world.history.stack.at(-1)).toBe(path);
  view.unmount();
});

describe('one switch over the open tab and the closed one (D-148)', () => {
  /** The page's own notices, sharing the device's one permission, as a browser's do. */
  const aNotifier = (
    start: NotificationPermission,
  ): { notifier: Notifier; asked: () => number; permission: () => NotificationPermission } => {
    let asked = 0;
    let permission = start;
    return {
      asked: () => asked,
      permission: () => permission,
      notifier: {
        permission: () => permission,
        request: (): Promise<NotificationPermission> => {
          asked += 1;
          if (permission === 'default') permission = 'granted';
          return Promise.resolve(permission);
        },
        show: () => true,
        close: () => undefined,
      },
    };
  };

  const openWith = async (
    api: Api,
    device: PushDevice | null,
    notifier: Notifier,
    owner?: string,
  ): Promise<View> => {
    const view = await renderApp(
      <>
        <Outlet />
        <Toaster dismissLabel="Close" />
      </>,
      { path: `/w/acme/c/${IDS.api}`, api, push: device, notifier },
    );
    if (owner !== undefined) view.world.storage.setItem(PUSH_OWNER_KEY, owner);
    await settle();
    return view;
  };

  const NO_KEY = (): Promise<{ publicKey: null }> => Promise.resolve({ publicKey: null });

  test('offered without push, for the open tab alone: asked once, nothing sent to the server', async () => {
    const page = aNotifier('default');
    const { api, sent } = aServer({ pushKey: NO_KEY });
    const view = await openWith(api, aDevice().device, page.notifier);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn on' }));
    await settle();
    expect(page.asked()).toBe(1);
    expect(sent).toEqual([]);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBe(IDS.me);
    await menu(view);
    expect(items(view)).toContain('Turn off');
    view.unmount();
  });

  test('offered in a browser with no push at all, whose server is never asked for a key', async () => {
    // `pushKey` is the fake API's refusal: a call fails the test.
    const view = await openWith(aSignedInApi(), null, aNotifier('default').notifier);
    await menu(view);
    expect(view.getByText('Notifications on this device')).toBeDefined();
    view.unmount();
  });

  test('refused by the person, blocked, and nothing remembered', async () => {
    const page = aNotifier('denied');
    const view = await openWith(aServer({ pushKey: NO_KEY }).api, null, page.notifier);
    await menu(view);
    expect(
      view.getByRole('menuitem', { name: 'Blocked: allow them in the browser’s site settings' }),
    ).toBeDefined();
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    view.unmount();
  });

  test('with push as well, one question covers both and the server is told', async () => {
    const page = aNotifier('default');
    const browser = aDevice({ permission: 'granted' });
    const { api, sent } = aServer();
    const view = await openWith(api, browser.device, page.notifier);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn on' }));
    await settle();
    expect(page.asked()).toBe(1);
    expect(browser.calls).toEqual(['subscribe BK']);
    expect(sent).toEqual([['subscribe', SUBSCRIPTION.endpoint, 'en']]);
    view.unmount();
  });

  test('on a later load, still on for its owner while the browser allows it', async () => {
    const view = await openWith(
      aServer({ pushKey: NO_KEY }).api,
      null,
      aNotifier('granted').notifier,
      IDS.me,
    );
    await menu(view);
    expect(items(view)).toContain('Turn off');
    view.unmount();
  });

  test('turned off, the open tab is off too, and the server it never told is not asked', async () => {
    const { api, sent } = aServer({ pushKey: NO_KEY });
    const view = await openWith(api, null, aNotifier('granted').notifier, IDS.me);
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Turn off' }));
    await settle();
    expect(sent).toEqual([]);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    await menu(view);
    expect(items(view)).toContain('Turn on');
    view.unmount();
  });
});
