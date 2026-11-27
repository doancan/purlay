/**
 * The disclosure: one native `<details>` with one chevron, wherever a part of a screen is closed until asked for.
 */
import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { person } from '../testing/user';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { Disclosure } from './disclosure';

installDom();

describe('Disclosure', () => {
  test('is closed until its summary is pressed, and then shows what it holds', async () => {
    const { container, getByText } = await renderApp(
      <Disclosure summary="Advanced filters">
        <p>Where</p>
      </Disclosure>,
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    await person().click(getByText('Advanced filters'));
    expect(details?.open).toBe(true);
    await expectNoAxeViolations(container);
  });

  test('opens on first draw when asked, as when a filter in it is already set', async () => {
    const { container } = await renderApp(
      <Disclosure summary="Advanced filters" open>
        <p>Where</p>
      </Disclosure>,
    );
    expect(container.querySelector('details')?.open).toBe(true);
  });

  test('draws its own chevron and hides the browser’s triangle, so every disclosure looks the same', async () => {
    const { container } = await renderApp(
      <Disclosure summary="Details">
        <p>id</p>
      </Disclosure>,
    );
    const summary = container.querySelector('summary');
    expect(summary?.className).toContain('disclosure-summary');
    // Two marks, one per state, neither read aloud: the summary's words are its name.
    expect(summary?.querySelectorAll('[aria-hidden="true"] svg')).toHaveLength(2);
  });
});
