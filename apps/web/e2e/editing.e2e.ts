/**
 * Editing and deleting one's own message, in a real browser, with another person watching (D-103):
 * the menu, the editor in the row, `E`, `↑` in an empty composer, the question before a delete — and
 * the other screen keeping up without a reload.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const rowWith = (page: Page, text: string): Locator =>
  page.locator('[data-message-row]', { hasText: text });

const editor = (page: Page): Locator => page.getByRole('textbox', { name: 'Edit your message' });

test.describe('my own message', () => {
  test('edited from its menu, and the other person sees the new words at once', async ({
    page,
    signIn,
    room,
    asPerson,
    expectNoAxe,
  }) => {
    const made = await room({ messages: [{ by: 'dogancan', text: 'teh deploy is at noon' }] });
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await expect(rowWith(alice, 'teh deploy is at noon')).toBeVisible();

    const row = rowWith(page, 'teh deploy is at noon');
    await row.hover();
    await row.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: /Edit/ }).click();
    await expect(editor(page)).toBeFocused();
    await expectNoAxe(row);
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type('the deploy is at noon');
    await page.keyboard.press('Enter');

    await expect(rowWith(page, 'the deploy is at noon')).toContainText('edited');
    await expect(rowWith(alice, 'the deploy is at noon')).toContainText('edited');
    await expect(alice.getByText('teh deploy is at noon')).toHaveCount(0);
  });

  test('E on it, and ↑ in an empty composer, open the same editor; Esc lets go', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ messages: [{ by: 'dogancan', text: 'mine to change' }] });
    await signIn();
    await page.goto(made.path);
    const row = rowWith(page, 'mine to change');
    await row.focus();
    await page.keyboard.press('e');
    await expect(editor(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveCount(0);

    await page.getByRole('textbox', { name: /^Message/ }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveValue('mine to change');
  });

  test('deleted after being asked, and gone from the other screen', async ({
    page,
    signIn,
    room,
    asPerson,
  }) => {
    const made = await room({
      messages: [
        { by: 'dogancan', text: 'a message I regret' },
        { by: 'dogancan', text: 'and one I keep' },
      ],
    });
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await expect(rowWith(alice, 'a message I regret')).toBeVisible();

    const row = rowWith(page, 'a message I regret');
    await row.hover();
    await row.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: /Delete/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this message?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Delete' }).click();

    await expect(rowWith(page, 'a message I regret')).toHaveCount(0);
    await expect(rowWith(alice, 'a message I regret')).toHaveCount(0);
    await expect(rowWith(alice, 'and one I keep')).toBeVisible();
  });
});
