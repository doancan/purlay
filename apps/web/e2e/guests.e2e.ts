/** Real guest authority, administrator edits, named invitation UI and live restricted conversations. */
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import {
  CreatedGuestInvitation,
  messageId,
  Message,
  SubscribedFrame,
  type MessagePage,
  type ThreadPage,
  type BookmarkList,
  type Channel,
  type ChannelBookmark,
  type Incident,
  type MeResponse,
  type WorkspaceGuestPage,
} from '@purlay/types';
import { expect, test, workspaceFor } from './fixtures';
import { isNarrow, openSettings, skipReleaseNotes, wallClock } from './support';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '../../..');

/** Verified mailbox fixture, limited to this browser world's scratch database. */
const verifyAddressFixture = async (database: string, userId: string): Promise<void> => {
  if (!/^\/purlay_e2e_[a-zA-Z0-9_]+$/.test(new URL(database).pathname))
    throw new Error('Address fixture needs a scratch database');
  await run(
    'bun',
    [
      '--no-env-file',
      '-e',
      `
      import { createDatabase } from './packages/db/src/index.ts';
      const url = new URL(process.env.DATABASE_URL);
      if (!/^\\/purlay_e2e_[a-zA-Z0-9_]+$/.test(url.pathname)) throw new Error('Not a scratch database');
      const db = createDatabase({ connectionString: url.toString(), poolSize: 1 });
      try { await db.updateTable('users').set({ email_verified: true })
        .where('id', '=', process.env.GUEST_USER_ID).execute(); }
      finally { await db.destroy(); }
    `,
    ],
    {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: database, GUEST_USER_ID: userId },
      maxBuffer: 64 * 1024,
    },
  );
};

/** Runs the actual named/verified invitation services on this project's scratch DB, never a production path. */
const admitFixture = async (
  database: string,
  workspaceId: string,
  ownerId: string,
  guestId: string,
  channelIds: readonly string[],
): Promise<void> => {
  if (!/^\/purlay_e2e_[a-zA-Z0-9_]+$/.test(new URL(database).pathname))
    throw new Error('Guest browser fixture needs a scratch database');
  await run(
    'bun',
    [
      '--no-env-file',
      '-e',
      `
    import { createDatabase } from './packages/db/src/index.ts';
    import { systemClock } from './apps/api/src/platform/clock.ts';
    import { requireWorkspaceMembership } from './apps/api/src/platform/tenancy.ts';
    import { chatWorkspaceChannels } from './apps/api/src/features/chat/channels/workspace-channels.ts';
    import { createGuestInvitation } from './apps/api/src/modules/workspaces/guest-invitations.ts';
    import { acceptInvitation } from './apps/api/src/modules/workspaces/invitations.ts';
    const url = new URL(process.env.DATABASE_URL);
    if (!/^\\/purlay_e2e_[a-zA-Z0-9_]+$/.test(url.pathname)) throw new Error('Not a scratch database');
    const db = createDatabase({ connectionString: url.toString(), poolSize: 1 });
    try {
      await db.transaction().execute(async (tx) => {
        const recipient = await tx.updateTable('users').set({ email_verified: true })
          .where('id', '=', process.env.GUEST_USER_ID).returning('email').executeTakeFirstOrThrow();
        const owner = await requireWorkspaceMembership(tx, process.env.GUEST_OWNER_ID, process.env.GUEST_WORKSPACE_ID);
        const invitation = await createGuestInvitation(tx, systemClock, owner,
          { email: recipient.email, channelIds: JSON.parse(process.env.GUEST_CHANNEL_IDS), accessExpiresAt: null }, chatWorkspaceChannels);
        await acceptInvitation(tx, systemClock, process.env.GUEST_USER_ID, invitation.token, undefined, chatWorkspaceChannels, true);
      });
    } catch { console.error('Guest fixture admission failed'); process.exitCode = 1; }
    finally { await db.destroy(); }
  `,
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: database,
        GUEST_WORKSPACE_ID: workspaceId,
        GUEST_OWNER_ID: ownerId,
        GUEST_USER_ID: guestId,
        GUEST_CHANNEL_IDS: JSON.stringify(channelIds),
      },
      maxBuffer: 64 * 1024,
    },
  );
};

test('an administrator edits a real guest without learning private scope; live revocation hides the removed conversation', async ({
  newcomer,
  world,
  expectNoAxe,
}, info) => {
  const owner = await newcomer('guest-owner');
  const admin = await newcomer('guest-admin');
  const guest = await newcomer('guest-person');
  const workspace = await workspaceFor(owner, admin);
  await owner.api.patch(`/api/workspaces/${workspace.id}/members/${admin.userId}`, {
    role: 'admin',
  });
  const publicChannel = await owner.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'supplier-conversation',
    type: 'public',
  });
  const privateChannel = await owner.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'confidential-purchasing',
    type: 'private',
  });
  const before = 'Message before restricted admission';
  const after = 'Message after restricted admission';
  await owner.api.say(publicChannel.id, before);
  await admitFixture(world.database, workspace.id, owner.userId, guest.userId, [
    publicChannel.id,
    privateChannel.id,
  ]);
  await owner.api.say(publicChannel.id, after);
  const page = await admin.page();
  const guestPage = await guest.page();
  await skipReleaseNotes(page.context());
  await skipReleaseNotes(guestPage.context());
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.name);
  });
  guestPage.on('pageerror', (error) => {
    pageErrors.push(error.name);
  });
  await guestPage.goto(`/w/${workspace.slug}/c/${publicChannel.id}`);
  await expect(guestPage.getByText(after, { exact: true })).toBeVisible();
  await expect(guestPage.getByText(before, { exact: true })).toHaveCount(0);
  const main = await openSettings(page, workspace.slug, 'members', 'Members');
  await main.getByRole('button', { name: 'Guests', exact: true }).click();
  const row = main.getByRole('list', { name: 'Guests' }).getByRole('listitem');
  await expect(row).toContainText(`@${guest.username}`);
  await expect(row).toContainText('1 hidden or unavailable channel');
  await expect(main).not.toContainText('confidential-purchasing');
  const initial = await admin.api.get<WorkspaceGuestPage>(`/api/workspaces/${workspace.id}/guests`);
  expect(initial.data[0]?.channelIds).toEqual([publicChannel.id]);
  expect(JSON.stringify(initial)).not.toContain(privateChannel.id);
  await row.getByRole('button', { name: /^Manage access for / }).click();
  for (const width of [320, 820, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(
      row.getByRole('checkbox', { name: '#supplier-conversation', exact: true }),
    ).toBeChecked();
    await expect(
      row.getByRole('checkbox', { name: '#confidential-purchasing', exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expectNoAxe(main);
    await page.screenshot({
      path: info.outputPath(`guest-edit-${String(width)}.png`),
      fullPage: true,
    });
  }
  await row.getByRole('checkbox', { name: '#supplier-conversation', exact: true }).uncheck();
  let failRefresh = true;
  await page.route(`**/api/workspaces/${workspace.id}/guests*`, async (route) => {
    if (route.request().method() === 'GET' && failRefresh)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'DATABASE_UNAVAILABLE', message: 'Controlled refresh failure.' },
        }),
      });
    else await route.continue();
  });
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' && response.url().endsWith(`/guests/${guest.userId}`),
  );
  await row.getByRole('button', { name: 'Save access', exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(main.getByRole('status')).toContainText(
    'Access saved. The list could not be refreshed.',
  );
  await expect(row).toContainText('No visible channels');
  await expect(main.getByRole('button', { name: 'Retry', exact: true })).toBeFocused();
  await expect(guestPage.getByText(after, { exact: true })).toHaveCount(0);
  expect((await guestPage.request.get(`/api/channels/${publicChannel.id}/messages`)).status()).toBe(
    404,
  );
  expect(
    (await guestPage.request.get(`/api/channels/${privateChannel.id}/messages`)).status(),
  ).toBe(200);
  failRefresh = false;
  await main.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(main.getByRole('alert')).toHaveCount(0);
  await row.getByRole('button', { name: /^Manage access for / }).click();
  await row.getByRole('checkbox', { name: '#supplier-conversation', exact: true }).check();
  await row.getByRole('button', { name: 'Save access', exact: true }).click();
  await expect(main.getByRole('status')).toHaveText('Guest access saved.');
  const newHistory = await guest.api.get<{ data: { content: string }[] }>(
    `/api/channels/${publicChannel.id}/messages`,
  );
  expect(newHistory.data.map((message) => message.content)).not.toContain(after);
  expect(newHistory.data.map((message) => message.content)).not.toContain(before);
  await row.getByRole('button', { name: /^Remove guest / }).click();
  await row.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row.getByRole('button', { name: /^Remove guest / })).toBeFocused();
  await row.getByRole('button', { name: /^Remove guest / }).click();
  await row.getByRole('button', { name: 'Remove guest', exact: true }).click();
  await expect(main.getByRole('status')).toHaveText('Guest removed.');
  await expect(main.getByRole('textbox', { name: 'Find a guest' })).toBeFocused();
  // A superseded in-page /me read may be cancelled while the session changes. Check the
  // committed membership separately, then the live screen and home without reloading it.
  const removedMe = await guest.api.get<MeResponse>('/api/me');
  expect(removedMe.memberships.some((membership) => membership.workspace.id === workspace.id)).toBe(
    false,
  );
  await expect(guestPage.getByRole('heading', { name: 'Nothing here', exact: true })).toBeVisible();
  expect(
    (await guestPage.request.get(`/api/channels/${privateChannel.id}/messages`)).status(),
  ).toBe(404);
  await guestPage.getByRole('link', { name: 'Go to your channels', exact: true }).click();
  await expect(
    guestPage.getByRole('heading', { name: 'You are not in a workspace yet', exact: true }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('deliberate conversion refreshes old history and the live subscription while keeping the composer draft', async ({
  newcomer,
  world,
  expectNoAxe,
}, info) => {
  const owner = await newcomer('conversion-owner');
  const guest = await newcomer('conversion-guest');
  const workspace = await workspaceFor(owner);
  const guestName = (await guest.api.get<MeResponse>('/api/me')).user.displayName;
  const channel = await owner.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'external-conversation',
    type: 'public',
  });
  const old = await owner.api.say(channel.id, 'Earlier content requires explicit full access');
  await admitFixture(world.database, workspace.id, owner.userId, guest.userId, [channel.id]);
  const fresh = await owner.api.say(channel.id, 'Visible after joining');
  const guestPage = await guest.page();
  const page = await owner.page();
  await skipReleaseNotes(guestPage.context());
  await skipReleaseNotes(page.context());
  await guestPage.goto(`/w/${workspace.slug}/c/${channel.id}`);
  await expect(guestPage.getByText(fresh.content, { exact: true })).toBeVisible();
  await expect(guestPage.getByText(old.content, { exact: true })).toHaveCount(0);
  const composer = guestPage.getByRole('textbox', { name: /^Message/ });
  await composer.fill('Draft survives wider access');
  const main = await openSettings(page, workspace.slug, 'members', 'Members');
  await main.getByRole('button', { name: 'Guests', exact: true }).click();
  const row = main.getByRole('list', { name: 'Guests' }).getByRole('listitem');
  await row.getByRole('button', { name: /^Make full member: / }).click();
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(
    row.getByRole('button', { name: 'Confirm full membership', exact: true }),
  ).toBeDisabled();
  await row
    .getByRole('checkbox', {
      name: 'I understand that this expands their access to earlier content.',
    })
    .check();
  for (const width of [320, 820, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expectNoAxe(main);
    await page.screenshot({
      path: info.outputPath(`guest-conversion-${String(width)}.png`),
      fullPage: true,
    });
  }
  await row.getByRole('button', { name: 'Confirm full membership', exact: true }).click();
  await expect(main.getByRole('status')).toHaveText('Guest converted to full membership.');
  await expect(guestPage.getByText(old.content, { exact: true })).toBeVisible();
  await expect(composer).toHaveText('Draft survives wider access');
  await owner.api.edit(old.id, 'Earlier content now receives live edits');
  await expect(
    guestPage.getByText('Earlier content now receives live edits', { exact: true }),
  ).toBeVisible();
  await composer.press('Enter');
  await expect(guestPage.getByText('Draft survives wider access', { exact: true })).toBeVisible();
  await main.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(main.getByRole('combobox', { name: `Role of ${guestName}` })).toBeVisible();
});

test('guest channel links and incident words respect admission while fresh sharing remains usable', async ({
  newcomer,
  world,
  expectNoAxe,
}, info) => {
  const owner = await newcomer('content-owner');
  const guest = await newcomer('content-guest');
  const workspace = await workspaceFor(owner);
  const channel = await owner.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'shared-supplier-room',
    type: 'public',
  });
  const root = `/api/channels/${channel.id}`;
  const oldBookmark = await owner.api.post<ChannelBookmark>(`${root}/bookmarks`, {
    url: 'https://private.example/prior-bookmark',
    title: 'Private earlier link title',
  });
  const oldId = messageId(wallClock());
  await owner.api.post<Incident>(`${root}/incident`, { id: oldId, severity: 2 });
  await owner.api.put(`${root}/incident/${oldId}/postmortem`, {
    content: 'Private earlier incident writeup',
    version: 0,
  });
  await admitFixture(world.database, workspace.id, owner.userId, guest.userId, [channel.id]);
  await owner.api.say(channel.id, 'Current conversation is available');
  const page = await guest.page();
  await skipReleaseNotes(page.context());
  const pageErrors: string[] = [];
  page.on('pageerror', (failure) => {
    pageErrors.push(failure.name);
  });
  await page.goto(`/w/${workspace.slug}/c/${channel.id}`);
  await expect(page.getByText('Current conversation is available', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: oldBookmark.title, exact: true })).toHaveCount(0);
  const openIncident = async (): Promise<void> => {
    if (isNarrow(page)) {
      await page.getByRole('button', { name: 'Channel menu' }).click();
      await page.getByRole('menuitem', { name: 'Incident', exact: true }).click();
    } else await page.getByRole('button', { name: 'Incident', exact: true }).click();
  };
  await openIncident();
  const panel = page.getByRole('complementary', { name: /Incident/ });
  await expect(panel.getByText('No incident', { exact: true })).toBeVisible();
  await expect(page.getByText('Private earlier incident writeup', { exact: true })).toHaveCount(0);
  expect((await page.request.get(`${root}/incident/${oldId}/updates`)).status()).toBe(404);
  await expectNoAxe(panel);
  await page.keyboard.press('Escape');
  await owner.api.patch(`${root}/incident/${oldId}`, { status: 'resolved' });
  const freshId = messageId(wallClock());
  await owner.api.post<Incident>(`${root}/incident`, { id: freshId, severity: 1 });
  await owner.api.put(`${root}/incident/${freshId}/postmortem`, {
    content: 'Current shared incident writeup',
    version: 0,
  });
  await owner.api.put(`${root}/incident/${freshId}/responders/${guest.userId}`);
  await owner.api.post<ChannelBookmark>(`${root}/bookmarks`, {
    url: 'https://shared.example/current-bookmark',
    title: 'Current shared link',
  });
  await expect(page.getByRole('link', { name: 'Current shared link', exact: true })).toBeVisible();
  await openIncident();
  await expect(panel.getByText('Current shared incident writeup', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Remove .+ from responders$/ })).toBeVisible();
  for (const width of [320, 820, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expectNoAxe(panel);
    await page.screenshot({
      path: info.outputPath(`guest-content-incident-${String(width)}.png`),
      fullPage: true,
    });
  }
  const removeResponder = panel.getByRole('button', { name: /^Remove .+ from responders$/ });
  await expect(removeResponder).toHaveText('Remove');
  await removeResponder.focus();
  await expect(removeResponder).toBeFocused();
  const removed = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' &&
      new URL(response.url()).pathname === `${root}/incident/${freshId}/responders/${guest.userId}`,
  );
  await page.keyboard.press('Enter');
  expect((await removed).status()).toBe(200);
  await expect(removeResponder).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'I’m responding', exact: true })).toBeVisible();
  await expectNoAxe(panel);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Add a bookmark', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a bookmark', exact: true });
  await dialog.getByRole('textbox', { name: 'Address', exact: true }).fill(oldBookmark.url);
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Our newly shared link');
  await expectNoAxe(dialog);
  await dialog.getByRole('button', { name: 'Add a bookmark', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Our newly shared link', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: oldBookmark.title, exact: true })).toHaveCount(0);
  const links = await guest.api.get<BookmarkList>(`${root}/bookmarks`);
  const shared = links.find((row) => row.url === oldBookmark.url);
  expect(shared?.id === oldBookmark.id).toBe(false);
  expect(shared?.addedBy?.id === guest.userId).toBe(true);
  expect(shared?.title === 'Our newly shared link').toBe(true);
  expect(pageErrors).toEqual([]);
});

test('a manager creates a named guest invitation and its recipient enters only the assigned conversation', async ({
  newcomer,
  world,
  expectNoAxe,
}, info) => {
  const owner = await newcomer('invite-manager');
  const guest = await newcomer('invite-recipient');
  const workspace = await workspaceFor(owner);
  const channel = await owner.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'supplier-planning',
    type: 'public',
  });
  await owner.api.say(channel.id, 'Private planning before the invitation');
  await verifyAddressFixture(world.database, guest.userId);
  const email = (await guest.api.get<MeResponse>('/api/me')).user.email;
  const page = await owner.page();
  await skipReleaseNotes(page.context());
  const main = await openSettings(page, workspace.slug, 'members', 'Members');
  await main.getByRole('button', { name: 'Guests', exact: true }).click();
  const form = main.getByRole('region', { name: 'New guest invitation' });
  await form.getByRole('button', { name: 'Invite a guest', exact: true }).click();
  await form.getByRole('textbox', { name: 'Guest email address', exact: true }).fill(email);
  await form.getByRole('checkbox', { name: '#supplier-planning', exact: true }).check();
  for (const width of [320, 820, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await expectNoAxe(main);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`guest-invitation-${String(width)}.png`),
      fullPage: true,
    });
  }
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/workspaces/${workspace.id}/guest-invitations`,
  );
  await form.getByRole('button', { name: 'Create guest invitation', exact: true }).click();
  const response = await posted;
  expect(response.status()).toBe(201);
  const raw: unknown = await response.json();
  if (!Value.Check(CreatedGuestInvitation, raw))
    throw new Error('Invalid created guest invitation');
  await expect(
    form.getByRole('status').filter({ hasText: 'Guest invitation created.' }),
  ).toHaveText('Guest invitation created.');
  await expect(form.getByRole('textbox', { name: 'Invitation link', exact: true })).toHaveValue(
    new RegExp(`/invite#${raw.token}$`),
  );
  const guestPage = await guest.page();
  await skipReleaseNotes(guestPage.context());
  await guestPage.goto(`/invite#${raw.token}`);
  await expect(
    guestPage.getByText('Guest invitation · 1 conversation', { exact: true }),
  ).toBeVisible();
  await guestPage.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(guestPage).toHaveURL(new RegExp(`/w/${workspace.slug}(?:/|$)`));
  await guestPage.goto(`/w/${workspace.slug}/c/${channel.id}`);
  await expect(
    guestPage.getByText('Private planning before the invitation', { exact: true }),
  ).toHaveCount(0);
  await owner.api.say(channel.id, 'New planning shared with our guest');
  await expect(
    guestPage.getByText('New planning shared with our guest', { exact: true }),
  ).toBeVisible();
  const me = await guest.api.get<MeResponse>('/api/me');
  expect(
    me.memberships.find((membership) => membership.workspace.id === workspace.id)?.access?.kind,
  ).toBe('guest');
  expect(
    (await guest.api.get<Channel[]>(`/api/workspaces/${workspace.id}/channels`)).map(
      (item) => item.id,
    ),
  ).toEqual([channel.id]);
});

test('a live new reply opens an earlier hidden thread without granting its old content or files', async ({
  newcomer,
  world,
  expectNoAxe,
}, info) => {
  const owner = await newcomer('earlier-thread-owner');
  const guest = await newcomer('earlier-thread-guest');
  const workspace = await workspaceFor(owner);
  const channel = await owner.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'partner-discussion',
    type: 'public',
  });
  const path = `/w/${workspace.slug}/c/${channel.id}`;
  const ownerPage = await owner.page();
  await skipReleaseNotes(ownerPage.context());
  await ownerPage.goto(path);
  const oldWords = 'Private kickoff before guest admission';
  await ownerPage.locator('input[type="file"]').setInputFiles({
    name: 'private-before-access.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Earlier private file content'),
  });
  const files = ownerPage.getByRole('list', { name: 'Files' });
  await expect(files.getByText('private-before-access.txt')).toBeVisible();
  await expect(files.getByText(/Uploading/)).toHaveCount(0);
  const box = ownerPage.getByRole('textbox', { name: 'Message partner-discussion' });
  await box.fill(oldWords);
  await box.press('Enter');
  // Sending uses the live socket; wait for the committed message, independent of transport.
  await expect
    .poll(async () =>
      (await owner.api.get<MessagePage>(`/api/channels/${channel.id}/messages`)).data.some(
        (message) => message.content === oldWords,
      ),
    )
    .toBe(true);
  const raw: unknown = (
    await owner.api.get<MessagePage>(`/api/channels/${channel.id}/messages`)
  ).data.find((message) => message.content === oldWords);
  if (!Value.Check(Message, raw)) throw new Error('Invalid earlier-root fixture response');
  const oldRoot = raw;
  expect(oldRoot.attachments).toHaveLength(1);
  const file = oldRoot.attachments[0];
  if (file === undefined) throw new Error('Missing old attachment fixture');
  await owner.api.say(channel.id, 'Private earlier reply', { parentId: oldRoot.id });
  await owner.api.resolve(oldRoot.id);
  await admitFixture(world.database, workspace.id, owner.userId, guest.userId, [channel.id]);
  const page = await guest.page();
  await skipReleaseNotes(page.context());
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.name);
  });
  const subscribed = Promise.withResolvers<undefined>();
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(payload));
      } catch {
        return;
      }
      if (
        Value.Check(SubscribedFrame, frame) &&
        frame.data.channels.some((entry) => entry.channelId === channel.id)
      )
        subscribed.resolve(undefined);
    });
  });
  await page.goto(path);
  await subscribed.promise;
  expect((await guest.api.get<MessagePage>(`/api/channels/${channel.id}/messages`)).data).toEqual(
    [],
  );
  const fresh = await owner.api.say(channel.id, 'A new answer after guest access began', {
    parentId: oldRoot.id,
  });
  const feed = page.getByRole('feed');
  const container = feed.locator(`[data-message-row][data-message-id="${oldRoot.id}"]`);
  await expect(container.getByText('Earlier messages are hidden', { exact: true })).toBeVisible();
  await expect(page.getByText(oldWords, { exact: true })).toHaveCount(0);
  await expect(page.getByText('private-before-access.txt', { exact: true })).toHaveCount(0);
  await expect(container.locator('time')).toHaveCount(0);
  await expect(container.getByRole('button', { name: 'Add reaction', exact: true })).toHaveCount(0);
  expect((await page.request.get(`/api/messages/${oldRoot.id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/attachments/${file.id}`)).status()).toBe(404);
  await container.focus();
  await container.press('t');
  const panel = page.getByRole('complementary', { name: 'Thread · #partner-discussion' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Thread · #partner-discussion' })).toBeFocused();
  await expect(panel.getByText(fresh.content, { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Resolve/ })).toHaveCount(0);
  await expect(panel.getByText('Private earlier reply', { exact: true })).toHaveCount(0);
  const follow = panel.getByRole('button', { name: 'Follow', exact: true });
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await follow.click();
  await expect
    .poll(
      async () =>
        (await guest.api.get<{ following: boolean }>(`/api/messages/${oldRoot.id}/follow`))
          .following,
    )
    .toBe(true);
  const replyBox = panel.getByRole('textbox', { name: 'Message a thread in partner-discussion' });
  await replyBox.fill('The guest can continue this conversation');
  await replyBox.press('Enter');
  await expect
    .poll(async () =>
      (await guest.api.get<ThreadPage>(`/api/messages/${oldRoot.id}/thread`)).data.some(
        (message) =>
          message.sender?.id === guest.userId &&
          message.content === 'The guest can continue this conversation',
      ),
    )
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await guest.api.get<Channel[]>(`/api/workspaces/${workspace.id}/channels`)).find(
          (item) => item.id === channel.id,
        )?.state?.unreadCount,
    )
    .toBe(0);
  for (const width of [320, 820, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(panel).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await expectNoAxe(panel);
    await page.screenshot({
      path: info.outputPath(`hidden-thread-${String(width)}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 820, height: 960 });
  await panel.getByRole('button', { name: 'Close thread', exact: true }).click();
  await expect(container).toBeFocused();
  await container.press('r');
  await expect(replyBox).toBeFocused();
  const preferences = await openSettings(page, workspace.slug, 'preferences', 'Preferences');
  await preferences.getByRole('radio', { name: 'Türkçe', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await page.goto(path + `?thread=${oldRoot.id}`);
  await expect(
    page.getByRole('complementary').getByText('Önceki mesajlar gizli', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 960 });
  const boundary = page.getByRole('complementary').locator(`[data-message-id="${oldRoot.id}"]`);
  await boundary.evaluate((element) => {
    for (const paragraph of element.querySelectorAll('p')) paragraph.style.fontSize = '2rem';
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
  await expectNoAxe(page.getByRole('complementary'));
  await page.screenshot({
    path: info.outputPath('hidden-thread-tr-large-text.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
