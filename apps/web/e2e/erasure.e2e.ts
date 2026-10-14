/**
 * Erasing one's own account (D-139 §5), against the real API: the dialog says what goes and what
 * stays, wants the username typed, and — done — the sign-in screen says the account is gone, and the
 * old session no longer opens anything.
 *
 * As gwen, an outsider of her own (`fixtures.ts`): an erased account is gone for every later test, so
 * nothing else may lean on it.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { openNav } from './support';

test.describe('erasing an account', () => {
  test('the username typed, the account erased, and the sign-in screen says so', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('gwen');
    const page = await asOutsider('gwen', 'fresh');
    await page.goto(`/w/${workspace.slug}`);
    await openNav(page);
    await page.getByRole('button', { name: /^Account: / }).click();
    await page.getByRole('menuitem', { name: 'Erase my account…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Erase your account' });
    const erase = dialog.getByRole('button', { name: 'Erase my account' });
    await expect(erase).toBeDisabled();
    const field = dialog.getByRole('textbox');
    const label = (await field.getAttribute('aria-label')) ?? '';
    const username = /, (.+), to confirm/.exec(
      (await dialog.getByText(/Type your username/).textContent()) ?? label,
    )?.[1];
    expect(username).toBeDefined();
    await field.fill(username ?? '');
    // On gwen's own page: the fixture's audit reads the default one.
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(violations.map((violation) => violation.id)).toEqual([]);
    await erase.click();

    await expect(page).toHaveURL(/\/sign-in\?reason=erased$/);
    await expect(page.getByRole('main').getByRole('status')).toHaveText('Your account was erased.');
    await page.goto(`/w/${workspace.slug}`);
    await expect(page).toHaveURL(/\/sign-in/);
  });
});
