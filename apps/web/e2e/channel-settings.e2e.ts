/**
 * A channel's details in real browsers (D-123): a rename reaches another person's sidebar and
 * header without a reload.
 */
import { expect, test } from './fixtures';
import { navLink } from './support';

test('a rename shows in another person’s sidebar and header, without a reload', async ({
  page,
  signIn,
  room,
  asPerson,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn();
  await page.goto(made.path);
  const alice = await asPerson('alice');
  await alice.goto(made.path);
  await expect(alice.getByRole('heading', { level: 1, name: made.name })).toBeVisible();

  await page.getByRole('heading', { level: 1 }).getByRole('button', { name: made.name }).click();
  await expect(page.getByRole('dialog', { name: `Details of #${made.name}` })).toBeVisible();
  // Its title follows the name, so it is found as the one dialog open.
  const dialog = page.getByRole('dialog');
  // Typed the way it is said; kept in the rule's form. Still a room's name, so the specs that read
  // the seeded workspace leave it out.
  await dialog.getByLabel('Name').fill(`Room Yeni ${made.name.slice('room-'.length)}`);
  const renamed = `room-yeni-${made.name.slice('room-'.length)}`;
  await expect(dialog.getByLabel('Name')).toHaveValue(renamed);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: `Details of #${renamed}` })).toBeVisible();
  // The one who made the room for the test, the viewer and Alice.
  await expect(dialog.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  await expectNoAxe(dialog);

  // Alice's screen hears it: her sidebar and the header she is looking at.
  // The header first: at a phone's width the sidebar opens over it.
  await expect(alice.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  await expect(await navLink(alice, renamed)).toBeVisible();
});
