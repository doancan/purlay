/** Catch up without silently reading messages outside the page the person saw (D-216). */
import { messageId, type MessagePage } from '@purlay/types';
import { expect, test } from './fixtures';

test('a never-read channel starts at its first unread and advances only through the displayed page', async ({
  page,
  signIn,
  room,
  tenant,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const viewer = api('dogancan');
  const writer = api('alice');
  for (let index = 1; index <= 25; index += 1) {
    await writer.say(made.id, `catchup ${String(index).padStart(2, '0')}`);
  }
  expect(await viewer.channelState(made.id)).toMatchObject({
    lastReadMessageId: null,
    unreadCount: 25,
  });
  await signIn();
  await page.goto(`/w/${tenant.slug}/unreads`);
  const channel = page
    .locator('section')
    .filter({ has: page.getByRole('link', { name: made.name, exact: true }) });
  await expect(channel.getByText('catchup 01', { exact: true })).toBeVisible();
  await expect(channel.getByText('catchup 20', { exact: true })).toBeVisible();
  await expect(channel.getByText('catchup 21', { exact: true })).toHaveCount(0);
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(25);
  await channel.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect.poll(async () => (await viewer.channelState(made.id))?.unreadCount).toBe(5);
  await expect(channel.getByText('catchup 21', { exact: true })).toBeVisible();
  await expect(channel.getByText('catchup 25', { exact: true })).toBeVisible();
  await channel.getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect.poll(async () => (await viewer.channelState(made.id))?.unreadCount).toBe(0);
  await expect(channel).toHaveCount(0);
});

test('reading the only waiting reply clears its unread state even when the thread was not followed', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const viewer = api('dogancan');
  const writer = api('alice');
  const root = await writer.say(made.id, 'Shift handover');
  await viewer.markRead(made.id, root.id);
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(0);
  await writer.say(made.id, 'The handover is complete', { parentId: root.id });
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(1);
  await signIn();
  await page.goto(`${made.path}?thread=${root.id}`);
  await expect(page.getByText('The handover is complete', { exact: true })).toBeVisible();
  await expect.poll(async () => (await viewer.channelState(made.id))?.unreadCount).toBe(0);
});

test('a waiting thread keeps live edits and a deleted parent, then opens its actual unread reply', async ({
  page,
  signIn,
  room,
  tenant,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const viewer = api('dogancan');
  const writer = api('alice');
  const root = await writer.say(made.id, 'Supplier handover before the update');
  await viewer.markRead(made.id, root.id);
  await writer.say(made.id, 'The delivery is waiting for confirmation', { parentId: root.id });
  await signIn();
  await page.goto(`/w/${tenant.slug}/unreads`);
  const channel = page.getByRole('region', { name: made.name, exact: true });
  await expect(
    channel.getByText('Supplier handover before the update', { exact: true }),
  ).toBeVisible();
  await writer.edit(root.id, 'Supplier handover after the update');
  await expect(
    channel.getByText('Supplier handover after the update', { exact: true }),
  ).toBeVisible();
  await expect(
    channel.getByText('Supplier handover before the update', { exact: true }),
  ).toHaveCount(0);
  await writer.remove(root.id);
  await expect(channel.getByText('This message was deleted.', { exact: true })).toBeVisible();
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(1);
  await channel.getByRole('link', { name: /Read unread replies/ }).click();
  await expect(
    page.getByText('The delivery is waiting for confirmation', { exact: true }),
  ).toBeVisible();
  await expect.poll(async () => (await viewer.channelState(made.id))?.unreadCount).toBe(0);
});

test('unreads preserve file-only content and usable controls in both themes at narrow and wide widths', async ({
  page,
  signIn,
  room,
  tenant,
  api,
  asPerson,
  expectNoAxe,
}, info) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const name = 'satin-alma-tedarik-planlama-ve-vardiya-bildirimleri';
  await api('dogancan').patch(`/api/channels/${made.id}`, { name });
  const writer = await asPerson('alice');
  await writer.goto(made.path);
  await expect(writer.getByRole('textbox', { name: `Message ${name}` })).toBeVisible();
  await writer.locator('input[type="file"]').setInputFiles({
    name: 'Vardiya-planı.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Ekip,Vardiya\nDepo,Sabah\n'),
  });
  await expect(
    writer.getByRole('list', { name: 'Files to send' }).getByText(/Uploading/),
  ).toHaveCount(0);
  await writer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(writer.getByRole('link', { name: /Download Vardiya-planı\.csv/ })).toBeVisible();
  await signIn();
  await page.goto(`/w/${tenant.slug}/unreads`);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      localStorage.setItem('purlay.theme', value);
    }, theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const channel = page.getByRole('region', { name, exact: true });
      await channel.scrollIntoViewIfNeeded();
      await expect(
        channel.getByRole('link', { name: /Download Vardiya-planı\.csv/ }),
      ).toBeInViewport();
      await expect(
        channel.getByRole('button', { name: 'Mark read', exact: true }),
      ).toBeInViewport();
      await expect(channel.getByRole('button', { name: 'Mark read', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expectNoAxe();
      await page.screenshot({
        path: info.outputPath(`unreads-${theme}-${String(width)}.png`),
        fullPage: true,
      });
    }
  }
  expect((await api('dogancan').channelState(made.id))?.unreadCount).toBe(1);
});

test('joining after history shows only subsequent unread messages', async ({
  page,
  signIn,
  room,
  tenant,
  api,
}) => {
  const made = await room({ members: ['alice'] });
  const writer = api('alice');
  await writer.say(made.id, 'Before joining: supplier history');
  await writer.say(made.id, 'Before joining: older delivery');
  await api('dogancan').join(made.id);
  await writer.say(made.id, 'After joining: new delivery');
  expect(await api('dogancan').channelState(made.id)).toMatchObject({ unreadCount: 1 });
  await signIn();
  await page.goto(`/w/${tenant.slug}/unreads`);
  const channel = page.getByRole('region', { name: made.name, exact: true });
  await expect(channel.getByText('After joining: new delivery', { exact: true })).toBeVisible();
  await expect(channel.getByText('Before joining: supplier history', { exact: true })).toHaveCount(
    0,
  );
  await expect(channel.getByText('Before joining: older delivery', { exact: true })).toHaveCount(0);
});

test('explicitly marking the first historical message unread preserves that requested range', async ({
  page,
  signIn,
  room,
  tenant,
  api,
}) => {
  const made = await room({ members: ['alice'] });
  const writer = api('alice');
  const first = await writer.say(made.id, 'Requested old handover');
  await writer.say(made.id, 'Requested old follow-up');
  const viewer = api('dogancan');
  await viewer.join(made.id);
  const newest = await writer.say(made.id, 'Recent handover');
  await viewer.markRead(made.id, newest.id);
  await viewer.put(`/api/channels/${made.id}/unread`, { fromMessageId: first.id });
  expect(await viewer.channelState(made.id)).toMatchObject({ unreadCount: 3 });
  await signIn();
  await page.goto(`/w/${tenant.slug}/unreads`);
  const channel = page.getByRole('region', { name: made.name, exact: true });
  await expect(channel.getByText('Requested old handover', { exact: true })).toBeVisible();
  await expect(channel.getByText('Recent handover', { exact: true })).toBeVisible();
});

test('thread read receipts preserve an unseen root and another thread, even when threads are read out of order', async ({
  room,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const writer = api('alice');
  const viewer = api('dogancan');
  const first = await writer.say(made.id, 'First handover');
  const second = await writer.say(made.id, 'Second handover');
  await viewer.markRead(made.id, second.id);
  const waitingRoot = await writer.say(made.id, 'Unseen channel announcement');
  const secondReply = await writer.say(made.id, 'Second thread answer', { parentId: second.id });
  const firstReply = await writer.say(made.id, 'First thread answer', { parentId: first.id });
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(3);
  const firstPage = await viewer.get<MessagePage>(`/api/messages/${first.id}/thread`);
  expect(firstPage.data.map((message) => message.id)).toEqual([firstReply.id]);
  await viewer.put(`/api/messages/${first.id}/thread/read`, { lastReadMessageId: firstReply.id });
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(2);
  const secondPage = await viewer.get<MessagePage>(`/api/messages/${second.id}/thread`);
  expect(secondPage.data.map((message) => message.id)).toEqual([secondReply.id]);
  await viewer.put(`/api/messages/${second.id}/thread/read`, { lastReadMessageId: secondReply.id });
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(1);
  await viewer.markRead(made.id, waitingRoot.id);
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(0);
});

test('reading a new message with an earlier client id does not resurrect pre-join history', async ({
  room,
  api,
}) => {
  const made = await room({ members: ['bob'] });
  const writer = api('bob');
  const old = await writer.say(made.id, 'History from before the person joined');
  const viewer = api('dogancan');
  await viewer.join(made.id);
  const arrived = await writer.say(made.id, 'New delivery with a slightly earlier client clock', {
    id: messageId(new Date(new Date(old.createdAt).getTime() - 10_000)),
  });
  expect(arrived.id < old.id).toBe(true);
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(1);
  await viewer.markRead(made.id, arrived.id);
  expect((await viewer.channelState(made.id))?.unreadCount).toBe(0);
});
