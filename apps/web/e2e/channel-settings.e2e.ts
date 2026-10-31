/**
 * A channel's details in real browsers (D-123): a rename reaches another person's sidebar and
 * header without a reload, leaving takes the channel off every tab of the person who left, and
 * somebody looking at a channel an admin archives is told so.
 */
import { expect, test } from './fixtures';
import { navLink, openNav } from './support';

test('a rename shows in another person’s sidebar and header; leaving takes it off both of the leaver’s tabs', async ({
  page,
  signIn,
  room,
  asPerson,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn();
  await page.goto(made.path);
  const second = await page.context().newPage();
  await second.goto(made.path);
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
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: `Details of #${renamed}` })).toBeVisible();
  // The one who made the room for the test, the viewer and Alice.
  // Who is in it is its own tab (D-154).
  await dialog.getByRole('tab', { name: /^Members/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Members (3)' })).toBeVisible();
  await expectNoAxe(dialog);

  // Alice's screen hears it: her sidebar and the header she is looking at.
  // The header first: at a phone's width the sidebar opens over it.
  await expect(alice.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  await expect(await navLink(alice, renamed)).toBeVisible();

  await dialog.getByRole('tab', { name: 'About' }).click();
  await dialog.getByRole('button', { name: 'Leave channel' }).click();
  await dialog.getByRole('button', { name: 'Leave channel' }).click();
  // Taken back to the workspace, which opens a channel of its own choosing: not this one.
  await expect(page).not.toHaveURL(new RegExp(made.id));
  const sidebar = await openNav(page);
  await expect(sidebar.getByRole('link', { name: new RegExp(renamed) })).toHaveCount(0);
  // The other tab was told on the socket, not by a reload.
  await expect(
    (await openNav(second)).getByRole('link', { name: new RegExp(renamed) }),
  ).toHaveCount(0);
  // Alice is still in it.
  await expect(await navLink(alice, renamed)).toBeVisible();
});

test('somebody looking at a channel an admin archives is told it was archived', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn('alice');
  await page.goto(made.path);
  await expect(page.getByRole('heading', { level: 1, name: made.name })).toBeVisible();
  // The heading is drawn from the HTTP answer; the socket may not be subscribed yet, and an archive
  // announced before it is would never reach this page. A message that arrives live proves it is.
  await api('dogancan').say(made.id, 'the socket is listening');
  await expect(
    page.locator('[data-message-row]', { hasText: 'the socket is listening' }),
  ).toBeVisible();

  await api('dogancan').del(`/api/channels/${made.id}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'This channel was archived' }),
  ).toBeVisible();
  await expect(
    (await openNav(page)).getByRole('link', { name: new RegExp(made.name) }),
  ).toHaveCount(0);
});
