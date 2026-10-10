/**
 * The browser's own storage, and what happens when the browser will not give it.
 */
import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { browserPorts } from './composer-ports';

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
