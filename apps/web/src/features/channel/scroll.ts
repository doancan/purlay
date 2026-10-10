/**
 * The arithmetic of a scrolled feed, with no DOM in it beyond three numbers.
 *
 * `UX.md` §6 states the rules; these are the measurements they are made of. A function
 * takes `{ scrollTop, scrollHeight, clientHeight }` — what a real element has and what a
 * test can set — so "within 80px of the bottom" is a line of arithmetic with a test, not a
 * behaviour only a browser can show.
 */

/** Closer than this to the bottom counts as at the bottom (`UX.md` §6). */
export const STICK_TO_BOTTOM_PX = 80;

/** How far above the unread marker the viewport starts, so the line above is in sight. */
export const MARKER_MARGIN_PX = 48;

export interface Scrollable {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export const distanceFromBottom = (el: Scrollable): number =>
  el.scrollHeight - el.scrollTop - el.clientHeight;

export const isNearBottom = (el: Scrollable): boolean =>
  distanceFromBottom(el) <= STICK_TO_BOTTOM_PX;

export const scrollToBottom = (el: Scrollable): void => {
  el.scrollTop = el.scrollHeight - el.clientHeight;
};

/**
 * Keeps what the reader was looking at where it was after content is added **above** it.
 *
 * Assigned from the *measurements before*, not added to whatever the position is now:
 * a browser that anchors scroll on its own has already moved the position by the same
 * amount, and adding again would move it twice. Setting an absolute value is the same
 * answer either way.
 */
export const restoreAfterPrepend = (
  el: Scrollable,
  before: { readonly scrollTop: number; readonly scrollHeight: number },
): void => {
  el.scrollTop = before.scrollTop + (el.scrollHeight - before.scrollHeight);
};
