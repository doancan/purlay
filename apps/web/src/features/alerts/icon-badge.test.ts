/**
 * The icons while something needs the person (D-148): the favicon with its dot, and the installed
 * app's badge, at a count; both put back at zero.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { paintIcons, WAITING_ICON } from './icon-badge';

installDom();

let calls: string[] = [];

/** Gives the page's navigator an app badge, or takes it away; read once the DOM is installed. */
const badging = (present: boolean): void => {
  for (const name of ['setAppBadge', 'clearAppBadge']) Reflect.deleteProperty(navigator, name);
  if (!present) return;
  Object.defineProperty(navigator, 'setAppBadge', {
    configurable: true,
    value: (count: number): Promise<void> => {
      calls.push(`set ${String(count)}`);
      return Promise.resolve();
    },
  });
  Object.defineProperty(navigator, 'clearAppBadge', {
    configurable: true,
    value: (): Promise<void> => {
      calls.push('clear');
      // Refused, as a page that is not installed is: nothing escapes.
      return Promise.reject(new DOMException('not installed', 'NotAllowedError'));
    },
  });
};

beforeEach(() => {
  calls = [];
  badging(true);
  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/svg+xml';
  link.setAttribute('href', '/favicon.svg');
  document.head.append(link);
});

afterEach(() => {
  badging(false);
  document.head.querySelector('link[rel="icon"]')?.remove();
});

const icon = (): string | null =>
  document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null;

describe('the icons', () => {
  test('carry the dot and the count while something waits, and are put back at zero', async () => {
    paintIcons(3);
    expect(icon()).toBe(WAITING_ICON);
    paintIcons(0);
    expect(icon()).toBe('/favicon.svg');
    await Promise.resolve();
    expect(calls).toEqual(['set 3', 'clear']);
  });

  test('a browser with no app badge still gets the dot', () => {
    badging(false);
    paintIcons(1);
    expect(icon()).toBe(WAITING_ICON);
    paintIcons(0);
    expect(icon()).toBe('/favicon.svg');
  });
});
