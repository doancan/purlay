/**
 * An accessibility check a component test can hold itself to.
 *
 * `axe-core` is the same engine the browser tests run (#139), so a rule that
 * fails here would fail there — but here it fails in milliseconds, on the one
 * component, with its name in the test.
 *
 * **Contrast is switched off, and only contrast.** It needs a layout engine, which
 * `happy-dom` is not, and it is already decided elsewhere: every colour pair is
 * computed in both themes by the token gate (`packages/tokens/src/pairs.ts`), a
 * stronger check than one sampled render. Everything else — names, roles, ARIA,
 * labels, landmarks, focus order that can be read from the tree — runs.
 *
 * **`region` is off too**, because it asks that all page content sit inside a
 * landmark, which is a question about a *page*; a component is a fragment of one.
 * The landmarks (`header`, `nav`, `main`, `aside`) belong to the application frame,
 * and the browser test audits that whole page (#139).
 *
 * **An overlay is audited by its own element, not by `baseElement`.** A modal
 * hides the rest of the page from assistive technology with `aria-hidden` while
 * it is open, and axe then reports that hidden page (which holds the button that
 * opened the dialog) as `aria-hidden` with focusable content — true of the tree,
 * and not a defect, because focus is trapped in the dialog. The thing to audit is
 * the dialog.
 *
 * **Loaded when asked for, not when imported.** `axe-core` reads the window it is
 * given, but loading it is slow enough to be worth paying only in the tests that
 * ask. (Measured across two test files, each with its own test DOM: one load works
 * for both.)
 *
 * A failure names the rule, what it says and the elements, one per line — a diff
 * of two arrays hides exactly the part that is wanted.
 */
import { expect } from 'bun:test';
import type { RunOptions } from 'axe-core';

const OPTIONS: RunOptions = {
  rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
};

export const expectNoAxeViolations = async (container: Element): Promise<void> => {
  const axe = (await import('axe-core')).default;
  const { violations } = await axe.run(container, OPTIONS);
  const described = violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} — ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
  );
  expect(described.join('\n')).toBe('');
};
