/**
 * A channel's details in real browsers (D-123): a rename reaches another person's sidebar and
 * header without a reload, leaving takes the channel off every tab of the person who left, and
 * somebody looking at a channel an admin archives is told so.
 */
import { expect, test } from './fixtures';
import { navLink, openNav, wallClock } from './support';
import type { ChannelList } from '@purlay/types';

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

test('a channel archived while this page had no connection says so when the connection returns (D-264)', async ({
  page,
  signIn,
  room,
  api,
  tenant,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  // The page's connection is cut by the test and refused while it is "down"; what the server sent in
  // the meantime went to nobody, and the archive is among it.
  let down = false;
  let cut = (): void => undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (down) {
      void ws.close();
      return;
    }
    const server = ws.connectToServer();
    cut = (): void => {
      void ws.close();
    };
    ws.onMessage((frame) => {
      server.send(frame);
    });
    server.onMessage((frame) => {
      ws.send(frame);
    });
  });
  await page.clock.install({ time: wallClock() });
  await signIn('alice');
  await page.goto(made.path);
  await expect(page.getByRole('heading', { level: 1, name: made.name })).toBeVisible();
  await api('dogancan').say(made.id, 'the socket is listening');
  await expect(
    page.locator('[data-message-row]', { hasText: 'the socket is listening' }),
  ).toBeVisible();

  down = true;
  cut();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('offline'));
  });
  await api('dogancan').del(`/api/channels/${made.id}`);
  // Age only wall time, then let the normal online cache refresh win while sockets stay down.
  // The generic missing state proves the HTTP answer committed before the next socket opens.
  await page.clock.setSystemTime(new Date(wallClock().getTime() + 60_000));
  const refreshed = page.waitForResponse(
    async (answer) =>
      answer.request().method() === 'GET' &&
      new URL(answer.url()).pathname === `/api/workspaces/${tenant.workspaceId}/channels` &&
      answer.status() === 200 &&
      !((await answer.json()) as ChannelList).some((channel) => channel.id === made.id),
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });
  await refreshed;
  await expect(
    page.getByRole('heading', { level: 1, name: 'That channel is not here' }),
  ).toBeVisible();
  down = false;
  await page.evaluate(() => {
    window.dispatchEvent(new Event('online'));
  });

  await expect(
    page.getByRole('heading', { level: 1, name: 'This channel was archived' }),
  ).toBeVisible();
});

test('an admin restores an archived channel from General, and it is back in a member’s sidebar without a reload (D-232)', async ({
  page,
  signIn,
  room,
  api,
  asPerson,
  world,
  expectNoAxe,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  const alice = await asPerson('alice');
  await alice.goto(made.path);
  await expect(alice.getByRole('heading', { level: 1, name: made.name })).toBeVisible();
  // As in the archive test above: a live message proves Alice's socket listens before anything is told.
  await api('dogancan').say(made.id, 'the socket is listening');
  await expect(
    alice.locator('[data-message-row]', { hasText: 'the socket is listening' }),
  ).toBeVisible();
  await api('dogancan').del(`/api/channels/${made.id}`);
  await expect(
    (await openNav(alice)).getByRole('link', { name: new RegExp(made.name) }),
  ).toHaveCount(0);

  await signIn();
  await page.goto(`/w/${world.workspace.slug}/settings/general`);
  const card = page.getByRole('region', { name: 'Archived channels' });
  const row = card.getByRole('listitem').filter({ hasText: `#${made.name},` });
  await expect(row).toBeVisible();
  await expectNoAxe(card);
  await row.getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(`#${made.name} is back.`)).toBeVisible();
  await expect(row).toHaveCount(0);

  await expect(await navLink(alice, made.name)).toBeVisible();
});

test('a channel renamed after its list was read and before its subscription was answered shows its new name without a reload', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  // The page's SUBSCRIBE is held on its way to the server: the lists are read, the socket is open and
  // listening to the person's own topic, and the channel's topic has nobody on it yet — the window that
  // a slow network or a busy node opens for as long as it likes, made as long as this test needs.
  const held: (string | Buffer)[] = [];
  let release = (): void => undefined;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const server = ws.connectToServer();
    let holding = true;
    release = (): void => {
      holding = false;
      for (const frame of held.splice(0)) server.send(frame);
    };
    ws.onMessage((frame) => {
      if (holding && typeof frame === 'string' && frame.includes('"op":"SUBSCRIBE"')) {
        held.push(frame);
        return;
      }
      server.send(frame);
    });
    server.onMessage((frame) => {
      ws.send(frame);
    });
  });
  await signIn();
  await page.goto(made.path);
  await expect(page.getByRole('heading', { level: 1, name: made.name })).toBeVisible();
  await expect.poll(() => held.length).toBe(1);

  // The room's maker renames it: the frame goes to the channel's topic, which no socket of the page is on.
  const renamed = `${made.name}-renamed`;
  await api('carol').patch(`/api/channels/${made.id}`, { name: renamed });
  release();

  await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();
  await expect(await navLink(page, renamed)).toBeVisible();
});
