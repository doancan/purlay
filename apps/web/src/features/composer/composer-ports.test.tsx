/**
 * The browser's own storage, and what happens when the browser will not give it.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { installDom } from '../../testing/dom';
import { browserPorts, isTouchOnly, TOUCH_ONLY_QUERY } from './composer-ports';

installDom();

describe("the browser's ports", () => {
  test('are its localStorage and its timers', () => {
    const ports = browserPorts();
    expect(ports.storage).toBe(window.localStorage);
    expect(typeof ports.schedule).toBe('function');
  });

  test('a browser that throws when storage is touched leaves a page with none', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage is blocked');
      },
    });
    try {
      expect(browserPorts().storage).toBeNull();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, 'localStorage', descriptor);
    }
  });
});

describe('a device that is only touch', () => {
  const answering = (matches: boolean, asked: string[]): typeof window.matchMedia =>
    ((query: string) => {
      asked.push(query);
      return { matches };
    }) as unknown as typeof window.matchMedia;

  test('is a coarse pointer that cannot hover, and the browser’s ports say so', () => {
    const asked: string[] = [];
    const spy = spyOn(window, 'matchMedia').mockImplementation(answering(true, asked));
    try {
      expect(isTouchOnly()).toBe(true);
      expect(browserPorts().touchOnly?.()).toBe(true);
      expect(asked[0]).toBe('(pointer: coarse) and (hover: none)');
    } finally {
      spy.mockRestore();
    }
  });

  test('is not, where the pointer hovers', () => {
    const spy = spyOn(window, 'matchMedia').mockImplementation(answering(false, []));
    try {
      expect(isTouchOnly()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test('is not, where the page has no media queries at all', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Reflect.deleteProperty(window, 'matchMedia');
    try {
      expect(isTouchOnly()).toBe(false);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, 'matchMedia', descriptor);
    }
  });

  test('is the line the stylesheet hides a key at: one query, so a hint never names a key Enter is not', () => {
    const stylesheet = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
    expect(stylesheet).toContain(`@custom-variant touch-only (@media ${TOUCH_ONLY_QUERY});`);
  });
});
