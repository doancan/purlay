/**
 * Which device last drove the page (D-247) — the key that decides whether a button wears its focus ring.
 *
 * `:focus-visible` already hides the ring after a click, but focus that the page *moves* (a menu or
 * dialog handing focus back to its trigger) shows it again, so a mouse user sees a ring they never asked
 * for. The page records the last input instead: after a pointer press `data-pointer` is set on the root
 * and `index.css` withholds the ring from everything that is not a place to type; the next key press
 * clears it. A text field keeps its ring either way — it is where the caret is.
 */
const POINTER_ATTRIBUTE = 'data-pointer';

/** Starts tracking on `root`; the returned function stops it. */
export const trackInputModality = (target: Document): (() => void) => {
  const root = target.documentElement;
  const onPointer = (): void => {
    root.setAttribute(POINTER_ATTRIBUTE, '');
  };
  const onKey = (event: KeyboardEvent): void => {
    // A modifier alone is not navigation; Tab, arrows, Enter and Space are.
    if (
      event.key === 'Shift' ||
      event.key === 'Control' ||
      event.key === 'Alt' ||
      event.key === 'Meta'
    )
      return;
    root.removeAttribute(POINTER_ATTRIBUTE);
  };
  target.addEventListener('pointerdown', onPointer, true);
  target.addEventListener('keydown', onKey, true);
  return () => {
    target.removeEventListener('pointerdown', onPointer, true);
    target.removeEventListener('keydown', onKey, true);
    root.removeAttribute(POINTER_ATTRIBUTE);
  };
};
