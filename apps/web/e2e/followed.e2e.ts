/** Followed conversations on real sessions: a workspace per test so personal lists do not collide. */
import type { FollowedThreadsPage, ThreadFollow } from '@purlay/types';
import { expect, test } from './fixtures';
import { apiAs, type ApiClient, type Tenant } from './support';

interface Space {
  readonly workspaceId: string;
  readonly slug: string;
  readonly channelId: string;
  readonly alice: ApiClient;
  readonly bob: ApiClient;
}

const aSpace = async (tenant: Tenant, privateChannel = false): Promise<Space> => {
  const alice = apiAs(tenant, 'alice');
  const bob = apiAs(tenant, 'bob');
  const slug = `following-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Operations', slug });
  const { token } = await bob.post<{ token: string }>(
    `/api/workspaces/${workspace.id}/invitations`,
  );
  await alice.post('/api/invitations/accept', { token });
  const channel = await bob.post<{ id: string }>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'shift-handover',
    type: privateChannel ? 'private' : 'public',
  });
  if (privateChannel)
    await bob.post(`/api/channels/${channel.id}/members`, { userId: tenant.userIds.alice });
  else await alice.post(`/api/channels/${channel.id}/join`);
  return { workspaceId: workspace.id, slug, channelId: channel.id, alice, bob };
};

test('the follow list includes participation and manual choices, preserves receipts and opens the first unread reply', async ({
  page,
  tenant,
  signIn,
  expectNoAxe,
}) => {
  const space = await aSpace(tenant);
  const authored = await space.alice.say(space.channelId, 'Stock-count handover');
  const participated = await space.bob.say(space.channelId, 'Supplier confirmation');
  await space.alice.say(space.channelId, 'I will check with the supplier', {
    parentId: participated.id,
  });
  const watched = await space.bob.say(space.channelId, 'Warehouse delivery');
  await space.alice.put(`/api/messages/${watched.id}/follow`, { following: true });
  const answer = await space.bob.say(space.channelId, 'The delivery has arrived', {
    parentId: watched.id,
  });
  const ignored = await space.bob.say(space.channelId, 'A conversation I let go');
  await space.alice.say(space.channelId, 'An earlier answer', { parentId: ignored.id });
  await space.alice.put(`/api/messages/${ignored.id}/follow`, { following: false });
  await space.alice.say(space.channelId, 'Answering again is not a follow choice', {
    parentId: ignored.id,
  });
  const before = await space.alice.channelState(space.channelId);
  await signIn('alice');
  await page.goto(`/w/${space.slug}/followed`);
  const list = page.getByRole('list', { name: 'Followed conversations', exact: true });
  await expect(list.getByRole('link', { name: /Stock-count handover/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /Supplier confirmation/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /Warehouse delivery/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /A conversation I let go/ })).toHaveCount(0);
  expect(await space.alice.channelState(space.channelId)).toEqual(before);
  await expectNoAxe();
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(page).toHaveURL(/filter=unread$/);
  await expect(list.getByRole('link', { name: /Stock-count handover/ })).toHaveCount(0);
  const link = list.getByRole('link', { name: /Warehouse delivery/ });
  await expect(link).toHaveAttribute('href', new RegExp(`message=${answer.id}`));
  await link.click();
  await expect(page.getByText('The delivery has arrived', { exact: true })).toBeVisible();
  await expect
    .poll(async () =>
      (
        await space.alice.get<FollowedThreadsPage>(
          `/api/workspaces/${space.workspaceId}/followed-threads?unreadOnly=true`,
        )
      ).data.some((row) => row.root.id === watched.id),
    )
    .toBe(false);
  expect(authored.id).not.toBe(participated.id);
});

test('unfollowing survives a reload and a network refusal restores the conversation', async ({
  page,
  tenant,
  signIn,
}) => {
  const space = await aSpace(tenant);
  const root = await space.bob.say(space.channelId, 'A purchasing conversation to follow');
  await space.alice.put(`/api/messages/${root.id}/follow`, { following: true });
  await signIn('alice');
  await page.goto(`/w/${space.slug}/followed`);
  const row = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: /A purchasing conversation to follow/ }) });
  await expect(row).toBeVisible();
  const pattern = `**/api/messages/${root.id}/follow`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'temporarily unavailable' },
      }),
    });
  });
  await row.getByRole('button', { name: 'Unfollow', exact: true }).click();
  await expect(page.getByText(/You are still following this thread/)).toBeVisible();
  await expect(row).toBeVisible();
  await page.unroute(pattern);
  await row.getByRole('button', { name: 'Unfollow', exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await space.alice.get<ThreadFollow>(`/api/messages/${root.id}/follow`)).following,
    )
    .toBe(false);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No followed conversations yet' })).toBeVisible();
});

test('a failed pending unfollow cannot restore a private conversation after membership removal', async ({
  page,
  tenant,
  signIn,
}) => {
  const space = await aSpace(tenant, true);
  const root = await space.bob.say(space.channelId, 'Private supplier negotiations');
  await space.alice.put(`/api/messages/${root.id}/follow`, { following: true });
  await signIn('alice');
  await page.goto(`/w/${space.slug}/followed`);
  const link = page.getByRole('link', { name: /Private supplier negotiations/ });
  const row = page.getByRole('listitem').filter({ has: link });
  await expect(row).toBeVisible();
  const reached = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const pattern = `**/api/messages/${root.id}/follow`;
  await page.route(pattern, async (route) => {
    if (route.request().method() !== 'PUT') {
      await route.continue();
      return;
    }
    reached.resolve(undefined);
    await release.promise;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DATABASE_UNAVAILABLE', message: 'temporarily unavailable' },
      }),
    });
  });
  await row.getByRole('button', { name: 'Unfollow', exact: true }).click();
  await reached.promise;
  try {
    await space.bob.del(`/api/channels/${space.channelId}/members/${tenant.userIds.alice}`);
    await expect
      .poll(
        async () =>
          (
            await space.alice.get<FollowedThreadsPage>(
              `/api/workspaces/${space.workspaceId}/followed-threads`,
            )
          ).data.length,
      )
      .toBe(0);
  } finally {
    release.resolve(undefined);
  }
  await expect(page.getByText(/You are still following this thread/)).toBeVisible();
  await expect(link).toHaveCount(0);
  await page.unroute(pattern);
});

test('long department names and keyboard actions fit at 320 pixels in either theme', async ({
  page,
  tenant,
  signIn,
  expectNoAxe,
}, info) => {
  const space = await aSpace(tenant);
  const name = 'purchasing-warehouse-operations-shift-handover-and-confirmations';
  await space.bob.patch(`/api/channels/${space.channelId}`, { name });
  await space.alice.say(space.channelId, 'SupplierConfirmation'.repeat(20));
  await space.alice.say(space.channelId, 'The next handover');
  await signIn('alice');
  await page.goto(`/w/${space.slug}/followed`);
  const first = page.getByRole('link', { name: /The next handover/ });
  await expect(first).toBeVisible();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const row = page.getByRole('listitem').filter({ has: first });
  const unfollow = row.getByRole('button', { name: 'Unfollow', exact: true });
  await unfollow.focus();
  await page.keyboard.press('Enter');
  const next = page.getByRole('link', { name: /SupplierConfirmation/ });
  await expect(next).toBeFocused();
  await expectNoAxe();
  await page.screenshot({ path: info.outputPath('followed-320.png'), fullPage: true });
});
