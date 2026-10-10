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

/** The message row the reader is looking at, and how far below the top of the box it sits. */
export interface Anchor {
  readonly id: string;
  readonly offset: number;
}

/** The first message row that is at least partly in sight, or null when there is none to name. */
export const readAnchor = (box: Element): Anchor | null => {
  const top = box.getBoundingClientRect().top;
  for (const row of box.querySelectorAll<HTMLElement>('[data-message-row]')) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const id = row.dataset['messageId'];
    return id === undefined ? null : { id, offset: rect.top - top };
  }
  return null;
};

/**
 * Puts the anchor row back as far below the top of the box as it was. The total height that was
 * added above is not enough to say where a row is: the row itself can change height when what is
 * above it arrives — a message that now follows one by the same person loses its name line — and
 * the reader would be moved by exactly that much (found in a browser: 24 px, one name line).
 */
export const holdAnchor = (box: HTMLElement, anchor: Anchor | null): void => {
  if (anchor === null) return;
  const row = box.querySelector<HTMLElement>(
    `[data-message-row][data-message-id="${CSS.escape(anchor.id)}"]`,
  );
  if (row === null) return;
  const moved = row.getBoundingClientRect().top - box.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(moved) >= 0.5) box.scrollTop += moved;
};
