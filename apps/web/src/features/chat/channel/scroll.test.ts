/** The arithmetic of a scrolled feed: three numbers in, a decision out. */
import { describe, expect, test } from 'bun:test';
import {
  STICK_TO_BOTTOM_PX,
  distanceFromBottom,
  isNearBottom,
  restoreAfterPrepend,
  scrollToBottom,
  type Scrollable,
} from './scroll';

const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 400): Scrollable => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('how far from the bottom', () => {
  test('is the content left below the viewport', () => {
    expect(distanceFromBottom(at(0))).toBe(600);
    expect(distanceFromBottom(at(600))).toBe(0);
    expect(distanceFromBottom(at(0, 300, 400))).toBe(-100);
  });

  test('80px counts as at the bottom and 81px does not (UX §6)', () => {
    expect(STICK_TO_BOTTOM_PX).toBe(80);
    expect(isNearBottom(at(600 - STICK_TO_BOTTOM_PX))).toBe(true);
    expect(isNearBottom(at(600 - STICK_TO_BOTTOM_PX - 1))).toBe(false);
    expect(isNearBottom(at(600))).toBe(true);
  });

  test('a list shorter than its box is always at the bottom', () => {
    expect(isNearBottom(at(0, 200, 400))).toBe(true);
  });
});

describe('moving', () => {
  test('to the bottom is the last position a box can have', () => {
    const el = at(0);
    scrollToBottom(el);
    expect(el.scrollTop).toBe(600);
  });

  test('after older content arrives above, the reader gets back the place they had', () => {
    const el = at(100, 1600, 400);
    restoreAfterPrepend(el, { scrollTop: 100, scrollHeight: 1000 });
    expect(el.scrollTop).toBe(700);
  });

  test('is the same answer when the browser already moved the position by itself', () => {
    // Anchoring in the browser had already carried the position from 100 to 700.
    const el = at(700, 1600, 400);
    restoreAfterPrepend(el, { scrollTop: 100, scrollHeight: 1000 });
    expect(el.scrollTop).toBe(700);
  });
});
