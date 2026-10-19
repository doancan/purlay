/**
 * The page's own notices (D-148) against a browser of the test's own: what it reads of the
 * person's answer, when it asks, what a notice carries, what a click on one does, and taking one
 * back. The real `Notification` is only in a browser; this is its shape, so the decisions made over
 * it are tested here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { browserNotifier, type Notice, type Notifier } from './notifier';

installDom();

interface Shown {
  readonly title: string;
  readonly options: NotificationOptions;
  closed: boolean;
  onclick: (() => void) | null;
  onclose: (() => void) | null;
}

interface Browser {
  permission: NotificationPermission;
  answer: NotificationPermission;
  asked: number;
  readonly shown: Shown[];
  focused: number;
  /** What the constructor throws instead of showing, if anything. */
  refuses: Error | undefined;
}

const restore: (() => void)[] = [];
const replace = (target: object, name: string, value: unknown): void => {
  const descriptor = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, { configurable: true, writable: true, value });
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
    permission,
    answer: 'granted',
    asked: 0,
    shown: [],
    focused: 0,
    refuses: undefined,
  };
  class FakeNotification {
    static get permission(): NotificationPermission {
      return browser.permission;
    }
    static requestPermission(): Promise<NotificationPermission> {
      browser.asked += 1;
      browser.permission = browser.answer;
      return Promise.resolve(browser.answer);
    }
    readonly record: Shown;
    constructor(title: string, options: NotificationOptions) {
      if (browser.refuses !== undefined) throw browser.refuses;
      this.record = { title, options, closed: false, onclick: null, onclose: null };
      browser.shown.push(this.record);
    }
    set onclick(handler: () => void) {
      this.record.onclick = handler;
    }
    set onclose(handler: () => void) {
      this.record.onclose = handler;
    }
    close(): void {
      this.record.closed = true;
      this.record.onclose?.();
    }
  }
  replace(globalThis, 'Notification', FakeNotification);
  replace(window, 'Notification', FakeNotification);
  replace(window, 'focus', () => {
    browser.focused += 1;
  });
  return browser;
};

const notifierOf = (): Notifier => {
  const notifier = browserNotifier();
  if (notifier === null) throw new Error('expected the browser to have notifications');
  return notifier;
};

const aNotice = (overrides: Partial<Notice> = {}): Notice => ({
  title: 'Ayşe in #general',
  body: 'Lunch at noon?',
  tag: 'conversation-1',
  onOpen: () => undefined,
  ...overrides,
});

describe('notices from an open page', () => {
  test('a browser without notifications has no notifier', () => {
    replace(window, 'Notification', undefined);
    Reflect.deleteProperty(window, 'Notification');
    expect(browserNotifier()).toBeNull();
  });

  test('reads what the person told the browser', () => {
    const browser = aBrowser('denied');
    const notifier = notifierOf();
    expect(notifier.permission()).toBe('denied');
    browser.permission = 'granted';
    expect(notifier.permission()).toBe('granted');
  });

  test('asks the person only when they were never asked', async () => {
    const browser = aBrowser('default');
    browser.answer = 'granted';
    const notifier = notifierOf();

    expect(await notifier.request()).toBe('granted');
    expect(browser.asked).toBe(1);

    // Answered once: the answer is given back without asking again.
    expect(await notifier.request()).toBe('granted');
    expect(browser.asked).toBe(1);
  });

  test('a person who said no is not asked again', async () => {
    const browser = aBrowser('denied');
    expect(await notifierOf().request()).toBe('denied');
    expect(browser.asked).toBe(0);
  });

  test('shows the notice with its words, its tag, the product mark and the page language', () => {
    const browser = aBrowser('granted');
    document.documentElement.lang = 'tr';
    expect(notifierOf().show(aNotice())).toBe(true);
    expect(browser.shown).toHaveLength(1);
    expect(browser.shown[0]?.title).toBe('Ayşe in #general');
    expect(browser.shown[0]?.options).toEqual({
      body: 'Lunch at noon?',
      tag: 'conversation-1',
      icon: '/favicon.svg',
      lang: 'tr',
    });
  });

  test('a click brings the page to the front, opens what it is about, and goes away', () => {
    const browser = aBrowser('granted');
    const opened: string[] = [];
    notifierOf().show(aNotice({ onOpen: () => opened.push('conversation-1') }));
    const shown = browser.shown[0];

    shown?.onclick?.();

    expect(browser.focused).toBe(1);
    expect(opened).toEqual(['conversation-1']);
    expect(shown?.closed).toBe(true);
  });

  test('takes back the notice with that tag, and only that one', () => {
    const browser = aBrowser('granted');
    const notifier = notifierOf();
    notifier.show(aNotice({ tag: 'conversation-1' }));
    notifier.show(aNotice({ tag: 'conversation-2' }));

    notifier.close('conversation-1');

    expect(browser.shown.map((shown) => shown.closed)).toEqual([true, false]);
  });

  test('taking back a tag it never showed does nothing', () => {
    const browser = aBrowser('granted');
    const notifier = notifierOf();
    notifier.show(aNotice({ tag: 'conversation-1' }));
    notifier.close('conversation-9');
    expect(browser.shown[0]?.closed).toBe(false);
  });

  test('a notice replaced by a newer one with its tag is not forgotten when the old one closes', () => {
    const browser = aBrowser('granted');
    const notifier = notifierOf();
    notifier.show(aNotice({ body: 'first' }));
    notifier.show(aNotice({ body: 'second' }));

    // The browser drops the first as the second replaces it.
    browser.shown[0]?.onclose?.();
    notifier.close('conversation-1');

    expect(browser.shown[1]?.closed).toBe(true);
  });

  test('a notice the person dismissed is not taken back again', () => {
    const browser = aBrowser('granted');
    const notifier = notifierOf();
    notifier.show(aNotice());
    const shown = browser.shown[0];
    shown?.onclose?.();
    if (shown !== undefined) shown.closed = false;

    notifier.close('conversation-1');

    expect(shown?.closed).toBe(false);
  });

  test('a browser that allows notices only from a worker shows none, and says so', () => {
    const browser = aBrowser('granted');
    browser.refuses = new TypeError('Illegal constructor');
    expect(notifierOf().show(aNotice())).toBe(false);
    expect(browser.shown).toHaveLength(0);
  });

  test('any other failure to show is not hidden', () => {
    const browser = aBrowser('granted');
    browser.refuses = new Error('something else');
    expect(() => notifierOf().show(aNotice())).toThrow('something else');
  });
});
