/** Personal channel organization, keyboard focus and same-owner live synchronization (#1198). */
import { expect, test } from './fixtures';
import { openNavigation } from './support';

test('a delayed group view keeps grouped channels reachable until their heading arrives', async ({
  page,
  signIn,
  room,
  tenant,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const groupId = crypto.randomUUID();
  const name = `Finance ${made.id.slice(-8)}`;
  const viewer = api('dogancan');
  await viewer.put(`/api/workspaces/${tenant.workspaceId}/channel-groups/${groupId}`, { name });
  await viewer.put(`/api/channels/${made.id}/sidebar-group`, { groupId });
  const held = Promise.withResolvers<undefined>();
  let requested = false;
  await page.route('**/assets/deferred-*.js', async (route) => {
    requested = true;
    await held.promise;
    await route.continue();
  });
  try {
    await signIn();
    const metadata = page.waitForResponse(
      (response) =>
        response.url().includes(`/workspaces/${tenant.workspaceId}/channel-groups?`) &&
        response.status() === 200,
    );
    await page.goto(made.path, { waitUntil: 'domcontentloaded' });
    await expect(
      page.getByRole('heading', { level: 1, name: made.name, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No messages yet', exact: true })).toBeVisible();
    await openNavigation(page);
    await metadata;
    await expect.poll(() => requested).toBe(true);
    const ordinary = page.getByRole('navigation', { name: 'Channels', exact: true });
    await expect(ordinary.getByRole('link', { name: made.name, exact: true })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: `Channel group: ${name}`, exact: true }),
    ).toHaveCount(0);
    held.resolve(undefined);
    await expect(
      page
        .getByRole('navigation', { name: `Channel group: ${name}`, exact: true })
        .getByRole('link', { name: made.name, exact: true }),
    ).toBeVisible();
    await expect(ordinary.getByRole('link', { name: made.name, exact: true })).toHaveCount(0);
  } finally {
    held.resolve(undefined);
  }
});

test('personal headings can be created, moved, renamed and deleted, with the other session kept current', async ({
  page,
  signIn,
  room,
  asPerson,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const name = `Satış ve operasyon ${made.id.slice(-8)}`;
  const renamed = `Finans ve satın alma ${made.id.slice(-8)}`;
  const other = await asPerson('dogancan');
  await other.goto(made.path);
  await expect(
    other.getByRole('heading', { level: 1, name: made.name, exact: true }),
  ).toBeVisible();
  await expect(other.getByRole('heading', { name: 'No messages yet', exact: true })).toBeVisible();
  await openNavigation(other);
  await signIn();
  await page.goto(made.path);
  await expect(page.getByRole('heading', { level: 1, name: made.name, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No messages yet', exact: true })).toBeVisible();
  await openNavigation(page);
  const options = page.getByRole('button', { name: /^Sidebar options/ });
  await options.click();
  await page.getByRole('menuitem', { name: 'New channel group' }).click();
  const editor = page.getByRole('dialog', { name: 'New channel group', exact: true });
  await editor.getByRole('textbox', { name: 'Group name' }).fill(name);
  await editor.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(options).toBeFocused();
  await expect(
    page.getByRole('navigation', { name: `Channel group: ${name}`, exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole('navigation', { name: `Channel group: ${name}`, exact: true }),
  ).toBeVisible();

  const row = page
    .getByRole('navigation', { name: 'Channels', exact: true })
    .getByRole('link', { name: made.name, exact: true });
  await row.focus();
  await row.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Move to group…' }).click();
  const move = page.getByRole('dialog', { name: `Move ${made.name}`, exact: true });
  await move.getByLabel('Group name').selectOption({ label: name });
  await move.getByRole('button', { name: 'Move channel', exact: true }).click();
  await expect(move).toBeHidden();
  const placed = page
    .getByRole('navigation', { name: `Channel group: ${name}`, exact: true })
    .getByRole('link', { name: made.name, exact: true });
  await expect(placed).toBeVisible();
  await expect(placed).toBeFocused();
  await expect(
    other
      .getByRole('navigation', { name: `Channel group: ${name}`, exact: true })
      .getByRole('link', { name: made.name, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('navigation', { name: 'Channels', exact: true })
      .getByRole('link', { name: made.name, exact: true }),
  ).toHaveCount(0);

  await page.getByRole('button', { name: `Options for ${name}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename group', exact: true }).click();
  const rename = page.getByRole('dialog', { name: 'Rename group', exact: true });
  await expect(rename.getByRole('textbox', { name: 'Group name' })).toHaveValue(name);
  await rename.getByRole('textbox', { name: 'Group name' }).fill(renamed);
  await rename.getByRole('button', { name: 'Save group', exact: true }).click();
  await expect(rename).toBeHidden();
  await expect(
    other.getByRole('navigation', { name: `Channel group: ${renamed}`, exact: true }),
  ).toBeVisible();
  await expectNoAxe();
  await page.getByRole('button', { name: `Options for ${renamed}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete group', exact: true }).click();
  const remove = page.getByRole('dialog', { name: `Delete ${renamed}?`, exact: true });
  await remove.getByRole('button', { name: 'Delete group', exact: true }).click();
  await expect(remove).toBeHidden();
  await expect(
    page
      .getByRole('navigation', { name: 'Channels', exact: true })
      .getByRole('link', { name: made.name, exact: true }),
  ).toBeVisible();
  await expect(
    other.getByRole('navigation', { name: `Channel group: ${renamed}`, exact: true }),
  ).toHaveCount(0);
  await expect(options).toBeFocused();
});

for (const theme of ['light', 'dark']) {
  for (const width of [320, 768, 1440]) {
    test(`long personal headings remain usable in ${theme} at ${String(width)} pixels`, async ({
      page,
      signIn,
      room,
      tenant,
      api,
      expectNoAxe,
    }, info) => {
      const made = await room({ members: ['dogancan', 'alice'] });
      const groupId = crypto.randomUUID();
      const name = `Satın alma tedarik planlama ve vardiya bildirimi ${made.id.slice(-8)}`;
      const viewer = api('dogancan');
      await viewer.put(`/api/workspaces/${tenant.workspaceId}/channel-groups/${groupId}`, { name });
      await viewer.put(`/api/channels/${made.id}/sidebar-group`, { groupId });
      await page.setViewportSize({ width, height: 900 });
      await signIn();
      await page.goto(made.path);
      await page.evaluate((value) => {
        localStorage.setItem('purlay.theme', value);
      }, theme);
      await page.reload();
      // The loading bar also has a navigation toggle. Wait for this channel's screen before
      // opening its overlay, so replacing the loading controls cannot dismiss the test's click.
      await expect(
        page.getByRole('heading', { level: 1, name: made.name, exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'No messages yet', exact: true }),
      ).toBeVisible();
      await openNavigation(page);
      const navigation =
        width < 900
          ? page.getByRole('dialog', { name: 'Workspace', exact: true })
          : page.getByRole('complementary', { name: 'Workspace', exact: true });
      await expect(navigation).toBeVisible();
      const group = navigation.getByRole('navigation', {
        name: `Channel group: ${name}`,
        exact: true,
      });
      await expect(group.getByRole('link', { name: made.name, exact: true })).toBeVisible();
      // Earlier cases leave real headings in this person's sidebar. Scroll the section into
      // view before checking its horizontal fit; a long list is allowed to scroll vertically.
      await group.scrollIntoViewIfNeeded();
      await expect(
        group.getByRole('button', { name: `Options for ${name}`, exact: true }),
      ).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expectNoAxe();
      await page.screenshot({
        path: info.outputPath(`channel-groups-${theme}-${String(width)}.png`),
      });
    });
  }
}
