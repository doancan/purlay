import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { ThemeMenu } from './theme-menu';

installDom();

describe('ThemeMenu', () => {
  test('lists system, light and dark, with the current choice checked', async () => {
    const { getByRole, getAllByRole } = await renderApp(<ThemeMenu />);
    await person().click(getByRole('button', { name: 'Theme' }));
    const radios = getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['System', 'Light', 'Dark']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
    ]);
  });

  test('choosing one applies it to the page and remembers it', async () => {
    const { getByRole, world } = await renderApp(<ThemeMenu />, { dark: false });
    expect(world.page.attributes['data-theme']).toBe('light');
    await person().click(getByRole('button', { name: 'Theme' }));
    await person().click(getByRole('menuitemradio', { name: 'Dark' }));
    expect(world.page.attributes['data-theme']).toBe('dark');
    expect(world.themeStorage.data['purlay.theme']).toBe('dark');
  });

  test('the trigger shows the theme that is showing, not the choice', async () => {
    const { getByRole, world } = await renderApp(<ThemeMenu />, { dark: true });
    const trigger = getByRole('button', { name: 'Theme' });
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('lucide-moon');
    act(() => {
      world.colourScheme.flip(false);
    });
    expect(trigger.querySelector('svg')?.getAttribute('class')).toContain('lucide-sun');
  });

  test('speaks Turkish when the interface does', async () => {
    const { getByRole, getAllByRole } = await renderApp(<ThemeMenu />, { locale: 'tr' });
    await person().click(getByRole('button', { name: 'Tema' }));
    expect(getAllByRole('menuitemradio').map((radio) => radio.textContent)).toEqual([
      'Sistem',
      'Açık',
      'Koyu',
    ]);
  });

  test('passes the accessibility audit', async () => {
    const { getByRole } = await renderApp(<ThemeMenu />);
    await person().click(getByRole('button', { name: 'Theme' }));
    await expectNoAxeViolations(getByRole('menu'));
  });
});
