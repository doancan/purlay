import { installDom } from '../../testing/dom';
import { describe, expect, test } from 'bun:test';
import { waitFor } from '@testing-library/react';
import { expectNoAxeViolations } from '../../testing/axe';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { OverlayProvider, useOverlay } from './overlay';
import { SettingsMenu } from './settings-menu';

installDom();

const mac = { platform: 'MacIntel' } as const;

/** What is open, written where a test can read it. */
const OverlayProbe = (): React.JSX.Element => {
  const { overlay } = useOverlay();
  return <output aria-label="open overlay">{overlay ?? 'none'}</output>;
};

const withOverlays = (): React.JSX.Element => (
  <OverlayProvider>
    <SettingsMenu platform={mac} />
    <OverlayProbe />
  </OverlayProvider>
);

describe('SettingsMenu', () => {
  test('holds the theme, the language and the shortcut reference, the current choices checked', async () => {
    const { getByRole, getAllByRole } = await renderApp(withOverlays());
    await person().click(getByRole('button', { name: 'Settings' }));
    const radios = getAllByRole('menuitemradio');
    expect(radios.map((radio) => radio.textContent)).toEqual([
      'System',
      'Light',
      'Dark',
      'English',
      'Türkçe',
    ]);
    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'true',
      'false',
    ]);
    expect(getByRole('menuitem', { name: /Keyboard shortcuts/ }).textContent).toContain('⌘/');
  });

  test('choosing a theme applies it to the page and remembers it', async () => {
    const { getByRole, world } = await renderApp(withOverlays(), { dark: false });
    await person().click(getByRole('button', { name: 'Settings' }));
    await person().click(getByRole('menuitemradio', { name: 'Dark' }));
    expect(world.page.attributes['data-theme']).toBe('dark');
    expect(world.themeStorage.data['purlay.theme']).toBe('dark');
  });

  test('choosing a language switches the words and remembers it', async () => {
    const { getByRole, world } = await renderApp(withOverlays());
    await person().click(getByRole('button', { name: 'Settings' }));
    await person().click(getByRole('menuitemradio', { name: 'Türkçe' }));
    await waitFor(() => {
      expect(getByRole('button', { name: 'Ayarlar' })).toBeDefined();
    });
    expect(world.localeStorage.data['purlay.locale']).toBe('tr');
    expect(world.page.attributes['lang']).toBe('tr');
  });

  test('speaks Turkish when the interface does', async () => {
    const { getByRole, getAllByRole } = await renderApp(withOverlays(), { locale: 'tr' });
    await person().click(getByRole('button', { name: 'Ayarlar' }));
    expect(getAllByRole('menuitemradio').map((radio) => radio.textContent)).toEqual([
      'Sistem',
      'Açık',
      'Koyu',
      'English',
      'Türkçe',
    ]);
    expect(getByRole('menuitem', { name: /Klavye kısayolları/ })).toBeDefined();
  });

  test('the shortcut reference opens the same overlay Cmd/Ctrl+/ does', async () => {
    const { getByRole, getByLabelText } = await renderApp(withOverlays());
    expect(getByLabelText('open overlay').textContent).toBe('none');
    await person().click(getByRole('button', { name: 'Settings' }));
    await person().click(getByRole('menuitem', { name: /Keyboard shortcuts/ }));
    expect(getByLabelText('open overlay').textContent).toBe('shortcuts');
  });

  test('offers no shortcut reference where nothing can show it', async () => {
    const { getByRole, queryByRole } = await renderApp(<SettingsMenu platform={mac} />);
    await person().click(getByRole('button', { name: 'Settings' }));
    expect(queryByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeNull();
  });

  test('says Ctrl where there is no ⌘', async () => {
    const { getByRole } = await renderApp(
      <OverlayProvider>
        <SettingsMenu platform={{ platform: 'Linux x86_64' }} />
      </OverlayProvider>,
    );
    await person().click(getByRole('button', { name: 'Settings' }));
    expect(getByRole('menuitem', { name: /Keyboard shortcuts/ }).textContent).toContain('Ctrl/');
  });

  test('passes the accessibility audit', async () => {
    const { getByRole } = await renderApp(withOverlays());
    await person().click(getByRole('button', { name: 'Settings' }));
    await expectNoAxeViolations(getByRole('menu'));
  });
});
