/**
 * The browser's copy port. Outside a secure context `navigator.clipboard` is absent, so the call
 * would throw before it could reject; the callers read a refusal from the promise, so that is what
 * the port gives them.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { useContentPorts } from './content-ports';

installDom();

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
  if (clipboard === undefined) Reflect.deleteProperty(navigator, 'clipboard');
  else Object.defineProperty(navigator, 'clipboard', clipboard);
});

describe('copying to the browser’s clipboard', () => {
  test('hands the text over', async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (text: string): Promise<void> => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    const { result } = renderHook(() => useContentPorts());
    await result.current.copy('hello');
    expect(written).toEqual(['hello']);
  });

  test('a browser with no clipboard refuses by rejecting, not by throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    const { result } = renderHook(() => useContentPorts());
    let returned: Promise<void> | undefined;
    expect(() => {
      returned = result.current.copy('hello');
    }).not.toThrow();
    expect(returned).toBeDefined();
    let refused = false;
    await returned?.catch(() => {
      refused = true;
    });
    expect(refused).toBe(true);
  });
});
