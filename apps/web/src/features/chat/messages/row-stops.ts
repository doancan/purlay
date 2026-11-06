/**
 * **A list of messages is one Tab stop** (`UX.md` §7, D-168). Tab reaches the list's one row — its
 * roving stop — and the next Tab leaves it; ↑ ↓ Home End move between rows (`row-keys.ts`). What is
 * inside a message — its links, its reaction chips, its thread's line, a code block's buttons and the
 * block itself, a diff's view, its files, its GitHub cards, its bar — is reached from that message:
 * **only the row that holds focus has stops inside it**, in the order they are drawn, and after its
 * last one Tab goes on to what follows the list. Every other row's controls are out of the Tab order.
 *
 * **Out of the Tab order, and nothing else.** A control taken out keeps `tabindex="-1"`: a click, a
 * tap, a screen reader's browse mode, a script's `focus()` (the image viewer giving focus back to its
 * thumbnail, a menu giving it back to its trigger) all still reach it. `inert` would have taken it
 * out of the accessibility tree and out of reach of the pointer too, which is what the bar needs and
 * the words must never have. A control that is focused by any of those ways brings its row in with it.
 *
 * **The DOM is the source.** Which controls a message has is decided by a dozen components, now and
 * later; asking each to take part is a rule each new one would have to remember. Here every row's own
 * stops are found by what makes an element one, whoever drew it: the ones it had are written down
 * before they are taken out and given back as they were, and what is drawn, or re-drawn, while the
 * row is out is taken out as it arrives. A control of a row drawn inside another row is that row's.
 *
 * **One row holds focus, for the document.** The feed and the thread panel are two lists, and focus
 * is in at most one row of either: the row that focus went into is let in and the one it left is
 * taken out, on the document's own focus events, so no row has to be told.
 */
import { useLayoutEffect } from 'react';

const ROW = '[data-message-row]';

/** What makes an element a stop for Tab, short of its `tabindex` saying otherwise. */
const STOP = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]',
].join(', ');

/** The `tabindex` a stop had before its row was taken out: null for none. */
const kept = new WeakMap<Element, string | null>();
/** Every row drawn, with what watches it for stops drawn while it is out. */
const watched = new Map<Element, MutationObserver>();
/** The row that holds focus, whose stops are in the Tab order. */
let current: Element | null = null;

const ownStops = (row: Element): Element[] =>
  Array.from(row.querySelectorAll(STOP)).filter((stop) => stop.closest(ROW) === row);

const takeOut = (stop: Element): void => {
  const was = stop.getAttribute('tabindex');
  // Already out — by its row, or by its author, who meant it.
  if (was === '-1') return;
  kept.set(stop, was);
  stop.setAttribute('tabindex', '-1');
};

const close = (row: Element): void => {
  for (const stop of ownStops(row)) takeOut(stop);
};

const open = (row: Element): void => {
  for (const stop of ownStops(row)) {
    if (!kept.has(stop)) continue;
    const was = kept.get(stop) ?? null;
    kept.delete(stop);
    if (was === null) stop.removeAttribute('tabindex');
    else stop.setAttribute('tabindex', was);
  }
};

/**
 * While a row is out, what its components draw or re-draw is taken out as it arrives: a code
 * block's highlighting, a reaction added, a block that stops being clamped and so becomes a stop.
 */
const watch = (row: Element, records: readonly MutationRecord[]): void => {
  if (row === current) return;
  let drawn = false;
  for (const record of records) {
    if (record.type === 'childList') {
      drawn = true;
      continue;
    }
    const stop = record.target as Element;
    // The row's own stop is its list's to move (roving focus), and a nested row's are its own.
    if (stop === row || stop.closest(ROW) !== row) continue;
    const now = stop.getAttribute('tabindex');
    if (now === '-1' && record.oldValue === '-1') {
      // Its author took it out while its row was: so it stays out when the row comes back.
      if (kept.has(stop)) kept.set(stop, '-1');
    } else if (stop.matches(STOP)) {
      // Its author changed it while its row was out: what it is given back is the new one.
      takeOut(stop);
    } else {
      // No longer a stop at all (a block clamped again): nothing to give back.
      kept.delete(stop);
    }
  }
  if (drawn) close(row);
};

/** Hears what a row's components changed that the observer has not yet been told. */
const flush = (row: Element): void => {
  const observer = watched.get(row);
  if (observer !== undefined) watch(row, observer.takeRecords());
};

/** Lets `row` in — or none — and takes out the row that had focus before. */
const settle = (row: Element | null): void => {
  if (row === current) return;
  const left = current;
  const next = row !== null && watched.has(row) ? row : null;
  // What changed while each was as it was is heard first, so a row never reads its own change as its
  // author's: the one coming in is still out, the one leaving still in.
  if (next !== null) flush(next);
  current = next;
  if (left !== null) {
    flush(left);
    close(left);
  }
  if (next !== null) open(next);
};

const rowOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest(ROW) : null;

const onFocusIn = (event: FocusEvent): void => {
  settle(rowOf(event.target));
};
const onFocusOut = (event: FocusEvent): void => {
  // Leaving for nothing — the window, the browser's own controls — or for somewhere that is not a row.
  if (rowOf(event.relatedTarget) === null) settle(null);
};

const listen = (on: boolean): void => {
  if (on) {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
  } else {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
  }
};

const register = (row: Element): (() => void) => {
  if (watched.size === 0) listen(true);
  const observer = new MutationObserver((records) => {
    watch(row, records);
  });
  observer.observe(row, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['tabindex'],
    attributeOldValue: true,
  });
  watched.set(row, observer);
  // A row drawn around focus — focus put in it before this ran — is the one; any other is out.
  if (rowOf(document.activeElement) === row) current = row;
  else close(row);
  return (): void => {
    observer.disconnect();
    watched.delete(row);
    if (current === row) current = null;
    if (watched.size === 0) listen(false);
  };
};

/** Keeps the controls inside this row out of the Tab order unless focus is in the row. */
export const useRowStops = (row: React.RefObject<HTMLElement | null>): void => {
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) return undefined;
    return register(element);
  }, [row]);
};
