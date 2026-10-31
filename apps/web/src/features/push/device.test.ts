/**
 * The browser's side of Web Push (#78, D-126) against a browser of the test's own: what it asks
 * the person, what it registers, how a subscription is described to the server, and which
 * messages from the worker it believes. The real APIs are only in a browser; these are their
 * shapes, so the decisions made over them are tested here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { PUSH_WORKER_PATH, browserPushDevice, mustInstallForPush, type PushDevice } from './device';

installDom();

/** A key as the server spells it: a 65-byte point in canonical base64url. */
const keyOf = (seed: number): string =>
  btoa(String.fromCharCode(4, ...Array.from({ length: 64 }, (_, index) => (index * seed) % 256)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const KEY = keyOf(7);
const OTHER_KEY = keyOf(11);

const bytesOf = (text: string): ArrayBuffer => {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
};

interface FakeSubscription {
  readonly endpoint: string;
  readonly options: { readonly applicationServerKey: ArrayBuffer };
  readonly getKey: (name: string) => ArrayBuffer;
  readonly unsubscribe: () => Promise<boolean>;
}

interface Browser {
  readonly log: string[];
  permission: NotificationPermission;
  answer: NotificationPermission;
  held: FakeSubscription | null;
  registered: boolean;
  /** What the worker does once registered: become active, or fail to install. */
  installs: 'activated' | 'redundant';
  readonly listeners: Set<(event: MessageEvent) => void>;
}

/** A worker installing: it becomes what the browser says once a listener is attached. */
const anInstallingWorker = (
  ends: 'activated' | 'redundant',
): { state: string; addEventListener: (type: string, listener: () => void) => void } => {
  const worker = {
    state: 'installing',
    addEventListener: (_type: string, listener: () => void): void => {
      queueMicrotask(() => {
        worker.state = ends;
        listener();
      });
    },
  };
  return worker;
};

const subscriptionOf = (browser: Browser, key: ArrayBuffer): FakeSubscription => ({
  endpoint: 'https://push.example.com/send/1',
  options: { applicationServerKey: key },
  getKey: (name: string): ArrayBuffer =>
    name === 'p256dh' ? new Uint8Array([4, 250, 251]).buffer : new Uint8Array([1, 2]).buffer,
  unsubscribe: (): Promise<boolean> => {
    browser.log.push('unsubscribe');
    browser.held = null;
    return Promise.resolve(true);
  },
});

const restore: (() => void)[] = [];
const replace = (target: object, name: string, value: unknown): void => {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, value });
  restore.push(() => {
    if (descriptor === undefined) Reflect.deleteProperty(target, name);
    else Object.defineProperty(target, name, descriptor);
  });
};

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

const aBrowser = (permission: NotificationPermission = 'default'): Browser => {
  const browser: Browser = {
    log: [],
    permission,
    answer: 'granted',
    held: null,
    registered: false,
    installs: 'activated',
    listeners: new Set(),
  };
  const pushManager = {
    getSubscription: (): Promise<FakeSubscription | null> => Promise.resolve(browser.held),
    subscribe: ({
      applicationServerKey,
    }: {
      applicationServerKey: Uint8Array;
    }): Promise<FakeSubscription> => {
      browser.log.push('subscribe');
      browser.held = subscriptionOf(browser, applicationServerKey.slice().buffer);
      return Promise.resolve(browser.held);
    },
  };
  const registration = {
    pushManager,
    installing: null as ReturnType<typeof anInstallingWorker> | null,
    waiting: null,
    active: null,
  };
  replace(navigator, 'serviceWorker', {
    register: (path: string, options: { scope: string }) => {
      browser.log.push(`register ${path} ${options.scope}`);
      browser.registered = true;
      registration.installing = anInstallingWorker(browser.installs);
      return Promise.resolve(registration);
    },
    get ready() {
      return Promise.resolve(registration);
    },
    getRegistration: () => Promise.resolve(browser.registered ? registration : undefined),
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      browser.listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
      browser.listeners.delete(listener);
    },
  });
  // Its presence is what is asked about.
  replace(window, 'PushManager', {});
  replace(window, 'Notification', {
    get permission() {
      return browser.permission;
    },
    requestPermission: () => {
      browser.log.push('ask');
      browser.permission = browser.answer;
      return Promise.resolve(browser.permission);
    },
  });
  return browser;
};

const deviceOf = (): PushDevice => {
  const device = browserPushDevice();
  if (device === null) throw new Error('the fake browser was not seen as one with push');
  return device;
};

describe('a browser with push', () => {
  test.each(['serviceWorker', 'PushManager', 'Notification'] as const)(
    'is none where it lacks %s',
    (name) => {
      aBrowser();
      expect(browserPushDevice()).not.toBeNull();
      Reflect.deleteProperty(name === 'serviceWorker' ? navigator : window, name);
      expect(browserPushDevice()).toBeNull();
    },
  );

  test('already refused, it neither asks again nor registers anything', async () => {
    const browser = aBrowser('denied');
    expect(await deviceOf().subscribe(KEY)).toBeNull();
    expect(browser.log).toEqual([]);
  });

  test('a worker that fails to install is a refusal, not a wait for ever', async () => {
    const browser = aBrowser('granted');
    browser.installs = 'redundant';
    const refused: unknown = await deviceOf()
      .subscribe(KEY)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(String(refused)).toBe('Error: the push worker did not install');
    expect(browser.log).toEqual([`register ${PUSH_WORKER_PATH} /`]);
  });

  test('asks the person once, and a refusal registers nothing', async () => {
    const browser = aBrowser();
    browser.answer = 'denied';
    const device = deviceOf();
    expect(device.permission()).toBe('default');
    expect(await device.subscribe(KEY)).toBeNull();
    expect(device.permission()).toBe('denied');
    expect(browser.log).toEqual(['ask']);
  });

  test('registers the worker at the root and describes the subscription as the server reads it', async () => {
    const browser = aBrowser('granted');
    const device = deviceOf();
    expect(await device.current()).toBeNull();
    const made = await device.subscribe(KEY);
    expect(browser.log).toEqual([`register ${PUSH_WORKER_PATH} /`, 'subscribe']);
    expect(made).toEqual({
      endpoint: 'https://push.example.com/send/1',
      p256dh: 'BPr7',
      auth: 'AQI',
      serverKey: KEY,
    });
    expect(await device.current()).toEqual(made);
  });

  test('a subscription made with another key goes before the new one is made', async () => {
    const browser = aBrowser('granted');
    browser.registered = true;
    browser.held = subscriptionOf(browser, bytesOf(OTHER_KEY));
    expect((await deviceOf().subscribe(KEY))?.serverKey).toBe(KEY);
    expect(browser.log).toEqual([`register ${PUSH_WORKER_PATH} /`, 'unsubscribe', 'subscribe']);
  });

  test('turned off, the subscription it holds is dropped, and none held is no error', async () => {
    const browser = aBrowser('granted');
    const device = deviceOf();
    await device.unsubscribe();
    await device.subscribe(KEY);
    await device.unsubscribe();
    expect(browser.log.at(-1)).toBe('unsubscribe');
    expect(await device.current()).toBeNull();
  });

  test('believes only the worker’s open message, and stops hearing when asked', () => {
    const browser = aBrowser();
    const heard: string[] = [];
    const stop = deviceOf().onOpen((url) => heard.push(url));
    const send = (data: unknown): void => {
      for (const listener of browser.listeners) listener(new MessageEvent('message', { data }));
    };
    send({ kind: 'push-open', url: '/w/acme/c/1' });
    send({ kind: 'push-open', url: '//evil.example/' });
    send({ kind: 'other', url: '/w/acme' });
    send('push-open');
    stop();
    send({ kind: 'push-open', url: '/w/acme/c/2' });
    expect(heard).toEqual(['/w/acme/c/1']);
  });
});

describe('whether push waits for the Home Screen (D-230)', () => {
  const browser = (standalone?: boolean): Navigator =>
    (standalone === undefined ? {} : { standalone }) as unknown as Navigator;

  test("iOS's Safari, not installed: it waits", () => {
    expect(mustInstallForPush(browser(false))).toBe(true);
  });

  test('installed on iOS, or any other browser: it does not', () => {
    expect(mustInstallForPush(browser(true))).toBe(false);
    expect(mustInstallForPush(browser())).toBe(false);
  });
});
