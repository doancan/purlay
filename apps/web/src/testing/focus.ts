/**
 * Where focus is, asserted by identity.
 *
 * **Never `expect(document.activeElement).toBe(element)`.** Under Bun 1.4.2 and happy-dom, inside a
 * mounted app, `toBe` reported two different rendered elements as the same: with focus in the
 * composer's textarea, `toBe(the thread panel's heading)` passed while `===` said `false` (#518). A
 * focus test that passes whatever has focus holds no keyboard path (`UX.md` §7), so the comparison
 * is made here with `===`, and a failure names both elements. Lint refuses the other form.
 */
import { expect } from 'bun:test';

/** Enough of an element to tell which one it is in a failure message. */
const describe = (element: Element | null): string => {
  if (element === null) return 'nothing';
  const label =
    element.getAttribute('aria-label') ??
    element.getAttribute('data-testid') ??
    element.textContent.trim().slice(0, 40);
  return label === ''
    ? `<${element.tagName.toLowerCase()}>`
    : `<${element.tagName.toLowerCase()}> "${label}"`;
};

/** Focus is on exactly `element`: the same node, not one that looks like it. */
export const expectFocusOn = (element: Element | null): void => {
  const active = document.activeElement;
  expect(
    active === element ? 'focused' : `focus is on ${describe(active)}, not on ${describe(element)}`,
  ).toBe('focused');
};

const FOCUSABLE =
  'a[href], button, input, select, textarea, summary, iframe, [contenteditable]:not([contenteditable="false"]), [tabindex]';

/** Whether a browser's Tab would stop on `element`: focusable, not taken out, not disabled or inert. */
const isTabStop = (element: HTMLElement): boolean => {
  const index = element.getAttribute('tabindex');
  if (index !== null && Number(index) < 0) return false;
  if (element.closest('[inert], [hidden]') !== null) return false;
  return !(element.matches(':disabled') && !element.matches('a, [tabindex]'));
};

/**
 * The page's Tab order, as a browser walks it: every stop in document order (nothing here has a
 * positive `tabindex`, which lint and review keep out). happy-dom has no sequential navigation of
 * its own, so this is the browser's rule written down, and `pressTab` follows it.
 */
export const tabOrder = (root: ParentNode = document.body): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isTabStop);

/**
 * Presses Tab — or Shift+Tab — where focus is: the key goes to the focused element first, as a
 * browser's does (the active row hears it), then focus moves to the next stop, read after the key,
 * from wherever focus was — on a stop or not.
 */
export const pressTab = (shift = false): HTMLElement | null => {
  const from =
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true }));
  const order = tabOrder();
  const relation = (stop: HTMLElement): number => from.compareDocumentPosition(stop);
  // An ancestor precedes, a descendant follows: a row's own controls come after it, and before it is
  // what came before the row.
  const next = shift
    ? order.filter((stop) => (relation(stop) & Node.DOCUMENT_POSITION_PRECEDING) !== 0).at(-1)
    : order.find((stop) => (relation(stop) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  next?.focus();
  return next ?? null;
};
