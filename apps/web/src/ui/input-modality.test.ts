import { installDom } from '../testing/dom';
import { afterEach, describe, expect, test } from 'bun:test';
import { trackInputModality } from './input-modality';

installDom();

describe('trackInputModality', () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
  });

  test('a pointer press marks the root and a navigation key clears it', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new Event('pointerdown'));
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(false);
  });

  test('modifier keys alone never clear it', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new Event('pointerdown'));
    for (const key of ['Control', 'Alt', 'Meta']) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key }));
    }
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(true);
  });

  test('stopping removes the mark and the listeners', () => {
    stop = trackInputModality(document);
    document.dispatchEvent(new Event('pointerdown'));
    stop();
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(false);
    document.dispatchEvent(new Event('pointerdown'));
    expect(document.documentElement.hasAttribute('data-pointer')).toBe(false);
  });
});
