/**
 * The gallery shows what it claims to: both themes, every colour, every icon —
 * and what it shows is accessible. It is the page the browser test photographs, so
 * what is missing here is missing from the snapshots.
 */
import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { colorTokens } from '@purlay/tokens';
import { within } from '@testing-library/react';
import { glyphNames } from '../components/icon';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { Toaster } from '../ui/toast';
import { Gallery } from './gallery';

installDom();

describe('the gallery', () => {
  test('shows dark and light side by side, each scoped to its own theme', async () => {
    const { getByRole } = await renderApp(<Gallery />);
    expect(getByRole('region', { name: 'dark theme' }).getAttribute('data-theme')).toBe('dark');
    expect(getByRole('region', { name: 'light theme' }).getAttribute('data-theme')).toBe('light');
  });

  test('has the same specimen in both, so the two can be compared', async () => {
    const { getByRole } = await renderApp(<Gallery />);
    const dark = within(getByRole('region', { name: 'dark theme' }));
    const light = within(getByRole('region', { name: 'light theme' }));
    expect(dark.getAllByRole('button').map((b) => b.textContent)).toEqual(
      light.getAllByRole('button').map((b) => b.textContent),
    );
  });

  test('shows every colour token, in each theme', async () => {
    const { getByRole } = await renderApp(<Gallery />);
    for (const theme of ['dark', 'light']) {
      const frame = within(getByRole('region', { name: `${theme} theme` }));
      for (const name of colorTokens) expect(frame.getAllByText(name).length).toBeGreaterThan(0);
    }
  });

  test('shows every glyph the interface can draw', async () => {
    const { getByRole } = await renderApp(<Gallery />);
    const frame = within(getByRole('region', { name: 'dark theme' }));
    for (const name of glyphNames) expect(frame.getAllByText(name).length).toBeGreaterThan(0);
  });

  test('passes the accessibility audit, both themes', async () => {
    const { container } = await renderApp(<Gallery />);
    await expectNoAxeViolations(container);
  });

  test('its overlays are live: the dialog opens and closes', async () => {
    const { getByRole, queryByRole } = await renderApp(<Gallery />);
    await person().click(getByRole('button', { name: 'Open dialog' }));
    expect(getByRole('dialog', { name: 'New channel' })).toBeDefined();
    await person().click(getByRole('button', { name: 'Cancel' }));
    expect(queryByRole('dialog')).toBeNull();
  });

  test('its controls do nothing, and can be pressed without harm', async () => {
    const { getAllByRole, getByRole } = await renderApp(
      <>
        <Gallery />
        <Toaster dismissLabel="Close" />
      </>,
    );
    const [retry] = getAllByRole('button', { name: 'Retry' });
    if (retry === undefined) throw new Error('the gallery shows a failed state with a Retry');
    await person().click(retry);
    await person().click(getByRole('button', { name: 'Menu' }));
    await person().click(getByRole('menuitem', { name: 'Settings' }));
    await person().click(getByRole('button', { name: 'Show toast' }));
    await person().click(getByRole('button', { name: 'Undo' }));
    expect(getByRole('button', { name: 'Show toast' })).toBeDefined();
  });

  test('its toast is live', async () => {
    // The frame mounts the toast region; the gallery alone does not.
    const { getByRole, getAllByRole } = await renderApp(
      <>
        <Gallery />
        <Toaster dismissLabel="Close" />
      </>,
    );
    await person().click(getByRole('button', { name: 'Show toast' }));
    expect(
      getAllByRole('status')
        .map((region) => region.textContent)
        .join(' '),
    ).toContain('Pasted text became a code block');
  });
});
