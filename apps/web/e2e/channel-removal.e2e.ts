/**
 * Taking somebody out of a channel, in real browsers (D-172): an owner removes Alice from a private
 * channel in its details, after being asked, and Alice — reading it — loses it from her sidebar at
 * once and is told she was removed, without a reload.
 */
import { expect, test } from './fixtures';
import { navLink } from './support';

test('an owner removes Alice from a private channel; her sidebar loses it live, and the page she reads says why', async ({
  page,
  signIn,
  room,
  asPerson,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice'], private: true });
  await signIn();
  await page.goto(made.path);
  const alice = await asPerson('alice');
  await alice.goto(made.path);
  await expect(alice.getByRole('heading', { level: 1, name: made.name })).toBeVisible();
  await expect(await navLink(alice, made.name)).toBeVisible();
  // The sidebar opens over the page at a phone's width: closed again, so the page is what is read.
  await alice.keyboard.press('Escape');

  await page.getByRole('heading', { level: 1 }).getByRole('button', { name: made.name }).click();
  const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('tab', { name: /^Members/ }).click();
  // The one who made the room for the test, the viewer and Alice.
  await expect(dialog.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  // Nobody removes themself here: that is Leave.
  await expect(dialog.getByRole('button', { name: /^Remove .* from the channel$/ })).toHaveCount(2);

  await dialog.getByRole('button', { name: /^Remove Alice.* from the channel$/ }).click();
  const question = dialog.getByRole('group', { name: /^Remove Alice.* from the channel$/ });
  await expect(question).toContainText('They stop seeing it, and their messages stay.');
  await expectNoAxe(dialog);
  await question.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Members (2)' })).toBeVisible();
  await expect(dialog.getByText(/^Alice/)).toHaveCount(0);

  // Alice's screen hears it: the page she is reading says what happened, and her sidebar loses it.
  await expect(
    alice.getByRole('heading', { level: 1, name: 'You were removed from this channel' }),
  ).toBeVisible();
  await expect(await navLink(alice, made.name)).toHaveCount(0);
});
