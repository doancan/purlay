/**
 * A private channel, made and shared in real browsers (D-104): nobody else sees it until a member
 * brings them in, and the person brought in sees it at once, without a reload.
 */
import { expect, test } from './fixtures';
import { navLink, openNav } from './support';

test('a private channel is made, a member brings Alice in, and it appears in her sidebar', async ({
  page,
  signIn,
  world,
  asPerson,
  expectNoAxe,
}) => {
  // Named as a room, so the specs that read the seeded workspace leave it out. Made by the viewer:
  // the people who make the other specs' rooms spend their write budget under load.
  const name = `room-private-${crypto.randomUUID().slice(0, 8)}`;
  await signIn();
  await page.goto(`/w/${world.workspace.slug}`);
  const alice = await asPerson('alice');
  await alice.goto(`/w/${world.workspace.slug}`);

  await (await openNav(page)).getByRole('button', { name: 'New channel' }).click();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('checkbox', { name: /Private/ }).check();
  await page.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();

  await page.getByRole('button', { name: 'Add people' }).click();
  const dialog = page.getByRole('dialog', { name: `Add people to ${name}` });
  await dialog.getByLabel('Find a person').fill(world.personas.alice.username);
  await dialog.getByRole('button', { name: 'Add' }).click();
  await expect(dialog.getByRole('button', { name: 'Added' })).toBeDisabled();
  await expectNoAxe(dialog);

  await expect(await navLink(alice, name)).toBeVisible();
});
