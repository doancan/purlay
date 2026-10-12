/**
 * The shortcut reference: what it lists, in which words for which platform, and what it
 * does not promise.
 */
import { describe, expect, test } from 'bun:test';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { isMacPlatform, keyLabels } from './platform';
import { ShortcutsDialog } from './shortcuts-dialog';

installDom();

const open = async (
  mac: boolean,
  locale: 'en' | 'tr' = 'en',
  onOpenChange: (open: boolean) => void = () => undefined,
): ReturnType<typeof renderApp> =>
  await renderApp(<ShortcutsDialog open mac={mac} onOpenChange={onOpenChange} />, { locale });

describe('the reference', () => {
  test('is a dialog with a name and a description, in three groups', async () => {
    const view = await open(true);
    const dialog = view.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog.getAttribute('aria-describedby')).not.toBeNull();
    expect(view.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual([
      'Navigation',
      'Messages',
      'Composer',
    ]);
    await expectNoAxeViolations(dialog);
  });

  test('lists the shortcuts that exist, and not the ones that do not', async () => {
    const view = await open(true);
    const text = view.getByRole('dialog').textContent;
    for (const sentence of [
      'Open the command palette',
      'Show this list',
      'Close the topmost thing',
      'Previous or next unread channel',
      'Move between messages',
      'Expand or collapse the focused thread',
      'Reply to the focused message',
      'Resolve or reopen the focused thread',
      'Send the message',
      'Add a line to the message',
      'Send from inside a code block',
      'Edit your own message',
      'Start or end Deep Work',
    ]) {
      expect(text).toContain(sentence);
    }
  });

  test('spells the modifiers for a Mac', async () => {
    const view = await open(true);
    const keys = [...view.getByRole('dialog').querySelectorAll('kbd')].map((k) => k.textContent);
    expect(keys).toContain('⌘');
    expect(keys).toContain('⇧');
    expect(keys).toContain('⌥');
    expect(keys).toContain('↵');
    expect(keys).not.toContain('Ctrl');
  });

  test('and for everything else', async () => {
    const view = await open(false);
    const keys = [...view.getByRole('dialog').querySelectorAll('kbd')].map((k) => k.textContent);
    expect(keys).toContain('Ctrl');
    expect(keys).toContain('Shift');
    expect(keys).toContain('Alt');
    expect(keys).toContain('Enter');
    expect(keys).not.toContain('⌘');
  });

  test('shows alternatives with a word between them', async () => {
    const view = await open(false);
    const row = view.getByText('Move between messages').closest('li');
    expect(row?.textContent).toContain('or');
    expect([...(row?.querySelectorAll('kbd') ?? [])].map((k) => k.textContent)).toEqual(['↑', '↓']);
  });

  test("closes with the button, and says so in the interface's language", async () => {
    const calls: boolean[] = [];
    const view = await open(false, 'tr', (next) => calls.push(next));
    expect(view.getByRole('dialog', { name: 'Klavye kısayolları' })).toBeDefined();
    expect(view.getByText('Komut paletini aç')).toBeDefined();
    expect(view.getAllByText('ya da').length).toBeGreaterThan(0);
    await person().click(view.getByRole('button', { name: 'Kapat' }));
    expect(calls).toEqual([false]);
  });
});

describe('the platform', () => {
  test.each([
    [{ platform: 'MacIntel' }, true],
    [{ platform: 'iPhone' }, true],
    [{ platform: 'Win32' }, false],
    [{ platform: 'Linux x86_64' }, false],
    [{ userAgentData: { platform: 'macOS' }, platform: 'Win32' }, true],
    [{ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' }, false],
    [{ userAgentData: {} }, false],
    [{}, false],
  ])('%j is a Mac: %p', (source, mac) => {
    expect(isMacPlatform(source)).toBe(mac);
  });

  test('prints each key by the name it has on its own keyboard', () => {
    expect(keyLabels(true)).toEqual({ mod: '⌘', shift: '⇧', alt: '⌥', enter: '↵', escape: 'Esc' });
    expect(keyLabels(false)).toEqual({
      mod: 'Ctrl',
      shift: 'Shift',
      alt: 'Alt',
      enter: 'Enter',
      escape: 'Esc',
    });
  });
});
