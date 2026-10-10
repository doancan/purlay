import { installDom } from '../testing/dom';
import { describe, expect, test } from 'bun:test';
import { waitFor } from '@testing-library/react';
import { expectNoAxeViolations } from '../testing/axe';
import { renderApp } from '../testing/render';
import { person } from '../testing/user';
import { LanguageMenu } from './language-menu';

installDom();

describe('LanguageMenu', () => {
  test('names each language in itself, with the current one checked', async () => {
    const { getByRole, getAllByRole } = await renderApp(<LanguageMenu />);
    await person().click(getByRole('button', { name: 'Language' }));
    const radios = getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.textContent)).toEqual(['English', 'Türkçe']);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['true', 'false']);
  });

  test('choosing a language switches the words and remembers it', async () => {
    const { getByRole, world } = await renderApp(<LanguageMenu />);
    await person().click(getByRole('button', { name: 'Language' }));
    await person().click(getByRole('menuitemradio', { name: 'Türkçe' }));
    await waitFor(() => {
      expect(getByRole('button', { name: 'Dil' })).toBeDefined();
    });
    expect(world.localeStorage.data['purlay.locale']).toBe('tr');
    expect(world.page.attributes['lang']).toBe('tr');
  });

  test('passes the accessibility audit', async () => {
    const { getByRole } = await renderApp(<LanguageMenu />);
    await person().click(getByRole('button', { name: 'Language' }));
    await expectNoAxeViolations(getByRole('menu'));
  });
});
