/**
 * A message's edit history, the whole way (#82, D-135): written and edited through the API, its
 * "edited" mark opened in a real browser, what it said before shown under what it says now; its author
 * removes the old words — clean of contrast and role violations in both themes and at both widths.
 */
import { expect, test } from './fixtures';

test.describe('a message’s edit history', () => {
  test('opened from “edited”: what it said before, which its author removes', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    const made = await room();
    const sent = await api('dogancan').say(made.id, 'the token is ghp_oops');
    await api('dogancan').edit(sent.id, 'the token is rotated');
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: 'Edited — show what it said before' }).click();
    const dialog = page.getByRole('dialog', { name: 'Edit history' });
    await expect(dialog.getByText('the token is rotated')).toBeVisible();
    const earlier = dialog.getByRole('list', { name: 'Earlier versions' });
    await expect(earlier.getByText('the token is ghp_oops')).toBeVisible();
    await expectNoAxe(dialog);

    await earlier.getByRole('button', { name: /^Remove the version/ }).click();
    await dialog
      .getByRole('group', { name: /Remove this version/ })
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(
      dialog.getByText('No earlier versions: they were not kept, or were removed.'),
    ).toBeVisible();
    await expect(dialog.getByText('the token is ghp_oops')).toHaveCount(0);
  });
});
