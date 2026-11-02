/**
 * "Mark all channels read" (D-238) as a person does it: back to unread in several channels, `Shift+Esc`
 * from the composer, every badge clears — and the same person's second device clears too, told by the
 * server rather than by a reload.
 *
 * A workspace of the test's own, between two newcomers: marking every channel read in the shared one
 * would read every other test's rooms there, in the other projects too.
 */
import { expect, test, workspaceFor } from './fixtures';
import { navLink, uniqueName } from './support';

test('Shift+Esc reads every channel, and the person’s other device clears too', async ({
  newcomer,
}) => {
  const reader = await newcomer('reader');
  const writer = await newcomer('writer');
  const workspace = await workspaceFor(reader, writer);
  const rooms: { readonly id: string; readonly name: string }[] = [];
  for (let made = 0; made < 3; made += 1) {
    const name = uniqueName('room');
    const { id } = await reader.api.post<{ id: string }>(
      `/api/workspaces/${workspace.id}/channels`,
      { name },
    );
    await reader.api.post(`/api/channels/${id}/members`, { userId: writer.userId });
    rooms.push({ id, name });
  }
  const [here, quiet, mentioned] = rooms as [
    { id: string; name: string },
    { id: string; name: string },
    { id: string; name: string },
  ];
  await writer.api.say(quiet.id, 'Dağıtım bitti, sürüm 2.4 yayında 🚀');
  await writer.api.say(mentioned.id, `@${reader.username} göz atar mısın?`);
  await writer.api.say(mentioned.id, 'Acil değil.');

  const phone = await reader.pageWithAnotherSession();
  await phone.goto(`/w/${workspace.slug}/c/${here.id}`);
  for (const room of [quiet, mentioned]) {
    await expect(await navLink(phone, room.name)).toHaveAccessibleName(
      new RegExp(`^unread ${room.name}`),
    );
  }

  const laptop = await reader.page();
  await laptop.goto(`/w/${workspace.slug}/c/${here.id}`);
  const composer = laptop.getByRole('textbox', { name: /^Message/ });
  await composer.click();
  await laptop.keyboard.press('Shift+Escape');

  await expect(laptop.getByText('All channels are marked read.')).toBeVisible();
  // The key was the command's, not the composer's: focus stayed where the person was typing.
  await expect(composer).toBeFocused();
  for (const page of [laptop, phone]) {
    for (const room of [quiet, mentioned]) {
      await expect(await navLink(page, room.name)).toHaveAccessibleName(
        new RegExp(`^${room.name}`),
      );
    }
  }
  const states = await reader.api.get<{ id: string; state: { unreadCount: number } | null }[]>(
    `/api/workspaces/${workspace.id}/channels`,
  );
  expect(states.map((channel) => channel.state?.unreadCount)).toEqual(states.map(() => 0));
});
