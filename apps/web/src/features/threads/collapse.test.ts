/**
 * The product's one animation, and the reason it is a token: the duration is the page's
 * `--duration-collapse`, so "no motion" is that token being `0ms`, which is what
 * `prefers-reduced-motion` makes it (`tokens.css`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { collapseDuration, foldAway, parseDuration } from './collapse';

installDom();

/** The page's root, looked up when used: the DOM exists only once the file's hooks have run. */
const page = (): HTMLElement => document.documentElement;
afterEach(() => {
  page().style.removeProperty('--duration-collapse');
  page().style.removeProperty('--easing-standard');
});

describe('a CSS time', () => {
  test.each([
    ['120ms', 120],
    ['0ms', 0],
    [' 0.12s ', 120],
    ['1s', 1000],
    ['.5s', 500],
    ['', 0],
    ['fast', 0],
    ['120', 0],
    ['-5ms', 0],
  ])('%j is %d ms', (value, ms) => {
    expect(parseDuration(value)).toBe(ms);
  });

  test("is read from the page's token at the moment it is asked", () => {
    page().style.setProperty('--duration-collapse', '120ms');
    expect(collapseDuration()).toBe(120);
    page().style.setProperty('--duration-collapse', '0ms');
    expect(collapseDuration()).toBe(0);
  });
});

describe('folding a thread away', () => {
  const element = (animate: unknown, height = 240): HTMLElement => {
    const el = document.createElement('div');
    el.getBoundingClientRect = (): DOMRect => ({ height }) as DOMRect;
    (el as unknown as { animate: unknown }).animate = animate;
    return el;
  };

  test("is height and opacity over the token's time and easing, then done", async () => {
    page().style.setProperty('--duration-collapse', '120ms');
    page().style.setProperty('--easing-standard', ' cubic-bezier(0.2, 0, 0, 1) ');
    const calls: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    await foldAway(
      element((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
        calls.push({ keyframes, options });
        return { finished: Promise.resolve() };
      }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      duration: 120,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
      fill: 'forwards',
    });
    expect(calls[0]?.keyframes).toEqual([
      { maxHeight: '240px', opacity: 1, overflow: 'hidden' },
      { maxHeight: '0px', opacity: 0, overflow: 'hidden' },
    ]);
  });

  test("uses the browser's own easing when the token is not set", async () => {
    page().style.setProperty('--duration-collapse', '120ms');
    let easing = '';
    await foldAway(
      element((_k: Keyframe[], options: KeyframeAnimationOptions) => {
        easing = String(options.easing);
        return { finished: Promise.resolve() };
      }),
    );
    expect(easing).toBe('ease');
  });

  test('is nothing at all when the token is zero (reduced motion) or the element cannot animate', async () => {
    let called = false;
    page().style.setProperty('--duration-collapse', '0ms');
    await foldAway(
      element(() => {
        called = true;
        return { finished: Promise.resolve() };
      }),
    );
    expect(called).toBe(false);
    page().style.setProperty('--duration-collapse', '120ms');
    await foldAway(element(undefined));
  });

  test('is finished even if the browser cancels it: the thread still closes', async () => {
    page().style.setProperty('--duration-collapse', '120ms');
    await foldAway(element(() => ({ finished: Promise.reject(new Error('cancelled')) })));
  });
});
