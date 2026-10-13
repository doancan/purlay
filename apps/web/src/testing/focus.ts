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
