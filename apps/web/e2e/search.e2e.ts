/**
 * Search, end to end (D-105): words written through the API are found by the real route in the real
 * database, a private conversation the viewer is not in is not, and a result takes the person to the
 * channel it is in.
 *
 * Each test makes rooms of its own (`support.ts`), and searches for a word only it wrote — the room's
 * unique name — because the four projects share one database.
 */
import { expect, tabTo, test } from './fixtures';
import { railLink, shellReady } from './support';

test.describe('search', () => {
  test('finds the words in a channel the person is in, and not in one they are not', async ({
    page,
    signIn,
    room,
    tenant,
    api,
    expectNoAxe,
  }) => {
    const open = await room({ members: ['dogancan', 'carol'] });
    const word = open.name;
    await api('carol').say(open.id, `the deploy notes are in ${word}`);
    // A private channel the viewer is not in, with the same word in it.
    const hidden = await api('carol').post<{ id: string }>(
      `/api/workspaces/${tenant.workspaceId}/channels`,
      { name: `${word}-private`, type: 'private' },
    );
    await api('carol').say(hidden.id, `a secret about ${word}`);

    await signIn();
    await page.goto(`/w/${tenant.slug}/c/${open.id}`);
    await shellReady(page);
    await (await railLink(page, 'Search')).click();
    const field = page.getByRole('searchbox', { name: 'Search messages' });
    // Arriving focuses the page, as every navigation does; the field is its first stop after the
    // header (which, narrow, holds the navigation toggle).
    await expect(page.locator('main')).toBeFocused();
    expect(await tabTo(page, field, 2)).toBeLessThanOrEqual(2);
    await field.fill(word.toUpperCase());
    await field.press('Enter');

    const found = page.getByRole('button', { name: new RegExp(`the deploy notes are in ${word}`) });
    await expect(found).toBeVisible();
    await expect(page.getByText(`a secret about ${word}`)).toHaveCount(0);
    await expect(page).toHaveURL(/\/search\?q=/);
    await expectNoAxe();

    await found.click();
    await expect(page).toHaveURL(new RegExp(`/c/${open.id}\\?message=`));
  });

  test('narrowed to one channel, finds the words there and not in another', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const here = await room({ members: ['dogancan', 'carol'] });
    const there = await room({ members: ['dogancan', 'carol'] });
    const word = here.name;
    await api('carol').say(here.id, `the rollback plan for ${word}`);
    await api('carol').say(there.id, `an unrelated note on ${word}`);

    await signIn();
    await page.goto(`/w/${tenant.slug}/search?q=${encodeURIComponent(word)}`);
    await expect(page.getByText(`an unrelated note on ${word}`)).toBeVisible();
    await page.getByRole('combobox', { name: 'Where' }).selectOption(here.id);
    await expect(page).toHaveURL(new RegExp(`in=${here.id}`));
    await expect(page.getByText(`the rollback plan for ${word}`)).toBeVisible();
    await expect(page.getByText(`an unrelated note on ${word}`)).toHaveCount(0);
  });
});
