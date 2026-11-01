/**
 * An announcement channel in real browsers (D-243): the owner says only owners and admins post in it,
 * a member looking at it is told so in the composer's place without a reload, the owner's
 * announcement reaches them, and they answer it in its thread — which the owner sees arrive.
 */
import { expect, test } from './fixtures';

test('an owner makes a channel an announcement channel; a member is told so live, reads the announcement and replies in its thread', async ({
  page,
  signIn,
  room,
  asPerson,
  api,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const notice = 'Only owners and admins post in this channel. You can still reply in a thread.';
  await signIn();
  await page.goto(made.path);
  const alice = await asPerson('alice');
  await alice.goto(made.path);
  await expect(alice.getByRole('heading', { level: 1, name: made.name })).toBeVisible();
  // The heading is drawn from the HTTP answer; a message that arrives live proves Alice's socket listens.
  await api('dogancan').say(made.id, `listening in ${made.name}`);
  await expect(
    alice.locator('[data-message-row]', { hasText: `listening in ${made.name}` }),
  ).toBeVisible();
  await expect(alice.getByLabel(`Message ${made.name}`)).toBeVisible();

  await page.getByRole('heading', { level: 1 }).getByRole('button', { name: made.name }).click();
  const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
  const box = dialog.getByRole('checkbox', { name: /Only owners and admins can post/ });
  await box.check();
  await expect(box).toBeChecked();
  await expectNoAxe(dialog);
  await page.keyboard.press('Escape');

  // Alice hears it on the socket: her composer gives way to the notice, and the header says it.
  await expect(alice.getByText(notice)).toBeVisible();
  await expect(alice.getByLabel(`Message ${made.name}`)).toHaveCount(0);
  await expect(alice.getByRole('img', { name: 'Only owners and admins post here' })).toBeVisible();
  await expectNoAxe();

  // The owner still has the composer, and posts.
  const announcement = `Bakım cuma 22:00'de, ${made.name}`;
  const composer = page.getByLabel(`Message ${made.name}`);
  await composer.fill(announcement);
  await composer.press('Enter');
  const row = alice.locator('[data-message-row]', { hasText: announcement });
  await expect(row).toBeVisible();

  // Alice answers in its thread, whose composer is still hers.
  const [root] = (
    await api('alice').get<{ data: { id: string; content: string }[] }>(
      `/api/channels/${made.id}/messages`,
    )
  ).data.filter((message) => message.content === announcement);
  expect(root).toBeDefined();
  await alice.goto(`${made.path}?thread=${root?.id ?? ''}`);
  const thread = alice.locator(`[data-thread-root="${root?.id ?? ''}"]`);
  const reply = thread.getByRole('textbox');
  await reply.fill('Teşekkürler, not aldım');
  await reply.press('Enter');
  await expect(thread.getByText('Teşekkürler, not aldım')).toBeVisible();
  // Still in the channel's column — which an open thread covers on a narrow window.
  await expect(alice.getByText(notice)).toHaveCount(1);

  // The owner sees the thread grow under the announcement.
  await expect(
    page.locator('[data-message-row]', { hasText: announcement }).getByRole('button', {
      name: /1 reply/,
    }),
  ).toBeVisible();
});
