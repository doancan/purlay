/**
 * Getting around without a mouse (`UX.md` §7): the palette, the unread jump, the shortcuts
 * reference, moving through messages, a Tab order with no trap and a ring on everything that can
 * take focus, the skip link, and where focus lands when the route changes.
 */
import type { Page } from '@playwright/test';
import { expect, focused, test } from './fixtures';
import { navLink, shellReady } from './support';

const modifier = 'ControlOrMeta';

/** Whether the focused element shows that it has focus: an outline or a ring, not nothing. */
const showsFocus = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return true;
    const style = getComputedStyle(element);
    const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
    const ring = style.boxShadow !== 'none' && style.boxShadow !== '';
    return outline || ring;
  });

/** Puts the sequential-focus starting point back at the top of the document, as a fresh page has it. */
const fromTop = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
    document.body.removeAttribute('tabindex');
  });

/** The app is up when its frame is: keys are listened for only after that. */
const ready = async (page: Page): Promise<void> => {
  await shellReady(page);
};

test.describe('the command palette', () => {
  test('opens on ⌘/Ctrl+K, filters as you type, opens a channel on Enter, and closes with Esc', async ({
    page,
    signIn,
    room,
  }) => {
    const target = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto('/w/acme-eng/questions');
    await ready(page);
    await page.keyboard.press(`${modifier}+K`);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill(target.name);
    await expect(dialog.getByRole('option').first()).toContainText(target.name);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/c/${target.id}$`));
    await expect(dialog).toHaveCount(0);

    await page.keyboard.press(`${modifier}+K`);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('finds a person who has no conversation yet and opens one, by keyboard alone', async ({
    page,
    signIn,
  }) => {
    await signIn();
    await page.goto('/w/acme-eng/questions');
    await ready(page);
    await page.keyboard.press(`${modifier}+K`);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await dialog.getByRole('combobox').fill('Carol');
    const option = dialog.getByRole('option', { name: /Carol/ }).first();
    await expect(option).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/carol/i);
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
  });

  test('says so when nothing matches', async ({ page, signIn }) => {
    await signIn();
    await page.goto('/w/acme-eng/questions');
    await ready(page);
    await page.keyboard.press(`${modifier}+K`);
    await page
      .getByRole('dialog', { name: 'Command palette' })
      .getByRole('combobox')
      .fill('zzzzqqqq');
    await expect(page.getByText('No match for “zzzzqqqq”').first()).toBeVisible();
  });
});

test.describe('the shortcuts reference', () => {
  test('opens on ⌘/Ctrl+/, lists the keys, and gives focus back when it closes', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    await ready(page);
    const box = page.getByRole('textbox', { name: /^Message/ });
    await box.focus();
    await page.keyboard.press(`${modifier}+/`);
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Open the command palette');
    await expect(dialog).toContainText('Previous or next unread channel');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(box).toBeFocused();
  });
});

test.describe('moving through the app', () => {
  test('Alt+↓ and Alt+↑ go to another channel that has something unread, and say where', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    // Carol reads: the jump opens whichever channel is next with something unread, and a channel
    // that is opened is read — which must not be the viewer's seeded unread state.
    const here = await room({ members: ['carol', 'alice'] });
    const unread = await room({ members: ['carol', 'alice'] });
    await api('alice').say(unread.id, 'something you have not read');
    await signIn('carol');
    await page.goto(here.path);
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
    await page.keyboard.press('Alt+ArrowDown');
    await expect(page).not.toHaveURL(new RegExp(`/c/${here.id}$`));
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
    await expect(page.getByText(/^Opened /)).toBeAttached();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page).toHaveURL(/\/c\/[0-9a-f-]{36}$/);
  });

  test('↑ and ↓ move focus from message to message, Home and End go to the ends, Esc goes to the composer', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({
      members: ['dogancan', 'alice'],
      messages: [
        { by: 'alice', text: 'first of three' },
        { by: 'alice', text: 'second of three' },
        { by: 'alice', text: 'third of three' },
      ],
    });
    await signIn();
    await page.goto(made.path);
    const rows = page.locator('[data-message-row]');
    await expect(rows).toHaveCount(3);
    await rows.nth(2).focus();
    await page.keyboard.press('ArrowUp');
    await expect(rows.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press('End');
    await expect(rows.nth(2)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeFocused();
  });
});

test.describe('focus', () => {
  test('the skip link is the first stop, shows itself, and moves focus into the conversation', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    await ready(page);
    await fromTop(page);
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to the conversation' });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport({ ratio: 1 });
    await page.keyboard.press('Enter');
    const inMain = await page.evaluate(() => {
      const active = document.activeElement;
      return active !== null && active.closest('main') !== null;
    });
    expect(inMain).toBe(true);
  });

  test('Tab walks every stop once and never gets stuck, and every stop shows a ring', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({
      members: ['dogancan', 'alice'],
      messages: [{ by: 'alice', text: 'something to land on' }],
    });
    await signIn();
    await page.goto(made.path);
    await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
    await ready(page);
    // From the composer onward: the sidebar of a workspace this busy has hundreds of stops, and the
    // top of the page is the skip link's test. Here: what follows, to the end and out.
    await page.getByRole('textbox', { name: /^Message/ }).focus();
    const seen: string[] = [await focused(page)];
    const unringed: string[] = [];
    for (let press = 0; press < 120; press++) {
      await page.keyboard.press('Tab');
      const where = await focused(page);
      // Back at the first stop, or out to the browser's own chrome: the loop is closed, no trap.
      if (where === 'body' || where === seen[0]) break;
      if (!(await showsFocus(page))) unringed.push(where);
      seen.push(where);
    }
    expect(seen.length, 'the walk ended instead of looping').toBeLessThan(120);
    expect(seen.length).toBeGreaterThan(1);
    expect(unringed, 'focused elements with no visible focus').toEqual([]);
    // The composer is on the way, and no stop is visited twice in a row.
    expect(seen.some((stop) => stop.startsWith('textarea'))).toBe(true);
    for (let index = 1; index < seen.length; index++) expect(seen[index]).not.toBe(seen[index - 1]);
    // Shift+Tab goes back the way it came.
    await page.keyboard.press('Shift+Tab');
    expect(await focused(page)).not.toBe('body');
  });

  test('after the route changes, focus is somewhere in the new screen and not left on a link that is gone', async ({
    page,
    signIn,
    room,
  }) => {
    const there = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto('/w/acme-eng/questions');
    await (await navLink(page, there.name)).dispatchEvent('click');
    await expect(page.getByRole('heading', { level: 1, name: there.name })).toBeVisible();
    const where = await page.evaluate(() => {
      const active = document.activeElement;
      return {
        body: active === document.body,
        connected: active?.isConnected ?? false,
        inside: active?.closest('main, aside, [role=dialog]') !== null,
      };
    });
    expect(where.connected).toBe(true);
    expect(where.inside).toBe(true);
  });
});
