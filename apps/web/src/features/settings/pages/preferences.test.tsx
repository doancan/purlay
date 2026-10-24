/**
 * Preferences (D-41, D-98, D-146), through the real frame at the page's address: the theme and the
 * language, each a set of choices shown at once, applied as one is chosen and kept on this device.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import { Outlet } from '../../../app/outlet';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (options: { theme?: 'light' | 'dark' } = {}): Promise<View> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/preferences',
    api: aSignedInApi(),
    ...options,
  });
  await settle();
  await view.findByRole('heading', { level: 1, name: 'Preferences' });
  return view;
};

const group = (view: View, name: string): Scope => within(view.getByRole('radiogroup', { name }));

const chosen = (view: View, name: string): string[] =>
  group(view, name)
    .getAllByRole<HTMLInputElement>('radio')
    .filter((radio) => radio.checked)
    .map((radio) => radio.value);

describe('preferences', () => {
  test('show every theme and every language at once, with the one in use chosen', async () => {
    const view = await open();
    expect(
      group(view, 'Theme')
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['System', 'Light', 'Dark', 'Midnight']);
    expect(chosen(view, 'Theme')).toEqual(['system']);
    expect(
      group(view, 'Language')
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['English', 'Türkçe']);
    expect(chosen(view, 'Language')).toEqual(['en']);
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('a theme chosen is applied at once and kept on this device', async () => {
    const view = await open();
    await person().click(group(view, 'Theme').getByRole('radio', { name: 'Dark' }));
    expect(view.world.themeStorage.data['purlay.theme']).toBe('dark');
    expect(view.world.page.attributes['data-theme']).toBe('dark');
    expect(chosen(view, 'Theme')).toEqual(['dark']);
    await person().click(group(view, 'Theme').getByRole('radio', { name: 'Light' }));
    expect(view.world.themeStorage.data['purlay.theme']).toBe('light');
    view.unmount();
  });

  test('a theme kept from before is the one shown chosen', async () => {
    const view = await open({ theme: 'dark' });
    expect(chosen(view, 'Theme')).toEqual(['dark']);
    view.unmount();
  });

  test('a language chosen is spoken at once, the page included', async () => {
    const view = await open();
    await person().click(group(view, 'Language').getByRole('radio', { name: 'Türkçe' }));
    await settle();
    expect(await view.findByRole('heading', { level: 1, name: 'Tercihler' })).toBeDefined();
    expect(chosen(view, 'Dil')).toEqual(['tr']);
    view.unmount();
  });
});
