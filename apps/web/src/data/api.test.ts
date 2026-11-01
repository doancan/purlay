/**
 * Every endpoint against the path `API.md` gives it, and the method and body the
 * contract says. The responses are real shapes, so the schema check in `http.ts`
 * is exercised too: an endpoint wired to the wrong schema fails here.
 */
import { NO_PROFILE } from '../testing/fixtures';
import { describe, expect, test } from 'bun:test';
import type { Attachment, DeviceSession } from '@purlay/types';
import { createApi, type Api } from './api';
import { ApiError } from './errors';
import { createHttp, type UploadRequest } from './http';

const ID = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const WHEN = '2026-09-09T08:00:00.000Z';
const user = { id: ID, username: 'alice', displayName: 'Alice', avatarUrl: null };
const state = { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 };
const channel = {
  id: ID,
  workspaceId: ID,
  name: 'api',
  topic: null,
  type: 'public',
  lastMessageAt: null,
  state,
  notificationLevel: 'mentions',
  starred: false,
  incident: null,
  codeRepository: null,
  onlyAdminsPost: false,
  peer: null,
  peers: [],
  memberCount: 1,
};
const message = {
  id: ID,
  channelId: ID,
  sender: user,
  githubEvent: null,
  content: 'hi',
  editedAt: null,
  deletedAt: null,
  createdAt: WHEN,
  parentId: null,
  thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
  reactions: [],
  mentions: [],
  attachments: [],
};
const workspace = { id: ID, name: 'acme', slug: 'acme', avatarUrl: null };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

const harness = (body: unknown): { api: Api; calls: Call[] } => {
  const calls: Call[] = [];
  const fetchFn = ((url: string, init: RequestInit) => {
    calls.push({
      method: String(init.method),
      url,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
  return { api: createApi(createHttp(fetchFn)), calls };
};

describe('the endpoints', () => {
  test('question metadata and personal searches use the shared contract at their own routes', async () => {
    const knowledge = {
      version: 0,
      isQuestion: true,
      assigneeId: null,
      acceptedAnswerId: null,
      decisionNote: 'Wait',
      decisionUrl: null,
    };
    const write = harness(message);
    await write.api.setKnowledge(ID, knowledge);
    expect(write.calls[0]).toEqual({
      method: 'PUT',
      url: `/api/messages/${ID}/knowledge`,
      body: knowledge,
    });
    const input = {
      name: 'Questions',
      query: { q: '', question: 'yes' as const, status: 'open' as const },
    };
    const saved = { ...input, id: ID, createdAt: WHEN };
    const save = harness(saved);
    expect(await save.api.saveSearch(ID, ID, input)).toEqual(saved);
    expect(save.calls[0]).toEqual({
      method: 'PUT',
      url: `/api/workspaces/${ID}/saved-searches/${ID}`,
      body: input,
    });
    const list = harness({ data: [saved], nextCursor: null });
    expect((await list.api.savedSearches(ID, ID)).data).toEqual([saved]);
    expect(list.calls[0]?.url).toBe(`/api/workspaces/${ID}/saved-searches?before=${ID}`);
    const remove = harness(null);
    await remove.api.deleteSearch(ID, ID);
    expect(remove.calls[0]?.method).toBe('DELETE');
    expect(remove.calls[0]?.url).toBe(`/api/workspaces/${ID}/saved-searches/${ID}`);
  });
  test('identity and workspaces', async () => {
    const me = harness({
      user: { ...user, email: 'a@example.test' },
      profile: NO_PROFILE,
      memberships: [{ workspace, role: 'owner', joinedAt: WHEN, deepWorkUntil: null }],
      mayCreateWorkspace: false,
      isServerAdmin: false,
      nameFromGitHub: false,
      mustEnrolTwoFactor: false,
      scheduledDeletions: [],
    });
    expect((await me.api.me()).user.username).toBe('alice');
    expect(me.calls[0]).toMatchObject({ method: 'GET', url: '/api/me' });

    const list = harness([{ workspace, role: 'member', joinedAt: WHEN, deepWorkUntil: null }]);
    expect(await list.api.workspaces()).toHaveLength(1);
    expect(list.calls[0]?.url).toBe('/api/workspaces');

    const created = harness(workspace);
    await created.api.createWorkspace({ name: 'acme', slug: 'acme' });
    expect(created.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/workspaces',
      body: { name: 'acme', slug: 'acme' },
    });

    const members = harness([{ user, role: 'member', joinedAt: WHEN, profile: NO_PROFILE }]);
    await members.api.members(ID);
    expect(members.calls[0]?.url).toBe(`/api/workspaces/${ID}/members`);
  });

  test('a device told by push, and the language it is told in (D-126)', async () => {
    const key = `B${'A'.repeat(86)}`;
    const read = harness({ publicKey: key });
    expect(await read.api.pushKey()).toEqual({ publicKey: key });
    expect(read.calls[0]).toMatchObject({ method: 'GET', url: '/api/push/key' });

    const device = harness(null);
    const subscription = {
      endpoint: 'https://push.example.com/1',
      keys: { p256dh: key, auth: 'A'.repeat(22) },
      locale: 'tr',
    } as const;
    await device.api.subscribePush(subscription);
    await device.api.unsubscribePush('https://push.example.com/1');
    await device.api.setLocale('en');
    expect(device.calls).toEqual([
      { method: 'POST', url: '/api/push/subscriptions', body: subscription },
      {
        method: 'POST',
        url: '/api/push/subscriptions/remove',
        body: { endpoint: 'https://push.example.com/1' },
      },
      { method: 'PUT', url: '/api/me/locale', body: { locale: 'en' } },
    ]);
  });

  test('a group conversation, a workspace’s name, and an unsent attachment let go', async () => {
    const group = harness(channel);
    await group.api.openConversation(ID, ['u1', 'u2']);
    expect(group.calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/workspaces/${ID}/conversations`,
      body: { userIds: ['u1', 'u2'] },
    });
    const renamed = harness(workspace);
    await renamed.api.renameWorkspace(ID, 'acme two');
    expect(renamed.calls[0]).toMatchObject({
      method: 'PATCH',
      url: `/api/workspaces/${ID}`,
      body: { name: 'acme two' },
    });
    const discarded = harness(null);
    await discarded.api.discardAttachment(ID);
    expect(discarded.calls[0]).toMatchObject({ method: 'DELETE', url: `/api/attachments/${ID}` });
  });

  test('the caller’s own profile (D-131)', async () => {
    const profile = { title: 'Lead', timeZone: 'Europe/Istanbul', status: null };
    const call = harness(profile);
    expect(await call.api.updateProfile({ title: 'Lead' })).toEqual(profile);
    expect(call.calls[0]).toMatchObject({
      method: 'PATCH',
      url: '/api/me/profile',
      body: { title: 'Lead' },
    });
  });

  test('saved messages: save, move, let go, and the lists (D-128)', async () => {
    const write = harness(null);
    await write.api.saveMessage(ID);
    await write.api.saveMessage(ID, 'completed');
    await write.api.unsaveMessage(ID);
    expect(write.calls).toEqual([
      { method: 'PUT', url: `/api/messages/${ID}/saved`, body: {} },
      { method: 'PUT', url: `/api/messages/${ID}/saved`, body: { state: 'completed' } },
      { method: 'DELETE', url: `/api/messages/${ID}/saved`, body: undefined },
    ]);
    const ids = harness([]);
    await ids.api.savedIds(ID);
    expect(ids.calls[0]).toMatchObject({ method: 'GET', url: `/api/workspaces/${ID}/saved/ids` });
    const list = harness({ data: [], nextCursor: null });
    await list.api.saved(ID, 'archived');
    await list.api.saved(ID, 'archived', 'c1');
    expect(list.calls.map((call) => call.url)).toEqual([
      `/api/workspaces/${ID}/saved?state=archived`,
      `/api/workspaces/${ID}/saved?state=archived&before=c1`,
    ]);
  });

  test('a message’s earlier versions: a page by cursor, and one removed (D-135)', async () => {
    const list = harness({ data: [], nextCursor: null });
    await list.api.messageVersions(ID);
    await list.api.messageVersions(ID, 'v1');
    const remove = harness(null);
    await remove.api.removeMessageVersion(ID, ID);
    expect([...list.calls, ...remove.calls].map((call) => [call.method, call.url])).toEqual([
      ['GET', `/api/messages/${ID}/versions`],
      ['GET', `/api/messages/${ID}/versions?before=v1`],
      ['DELETE', `/api/messages/${ID}/versions/${ID}`],
    ]);
  });

  test('a channel’s pins: the list, pin and let go (D-130)', async () => {
    const list = harness([]);
    await list.api.pins(ID);
    expect(list.calls[0]).toMatchObject({ method: 'GET', url: `/api/channels/${ID}/pins` });
    const write = harness(null);
    await write.api.pin(ID);
    await write.api.unpin(ID);
    expect(write.calls.map((call) => [call.method, call.url])).toEqual([
      ['PUT', `/api/messages/${ID}/pin`],
      ['DELETE', `/api/messages/${ID}/pin`],
    ]);
  });

  test('a channel’s incident: read, declared, changed, its timeline by cursor (D-137)', async () => {
    const incident = {
      id: ID,
      channelId: ID,
      severity: 2,
      status: 'investigating',
      declaredBy: null,
      declaredAt: '2026-09-09T11:00:00.000Z',
      responders: [],
      runbookUrl: null,
      postmortem: '',
      postmortemVersion: 0,
      resolvedAt: null,
    };
    const read = harness({ incident: null });
    expect(await read.api.incident(ID)).toEqual({ incident: null });
    const write = harness(incident);
    expect((await write.api.declareIncident(ID, { id: ID, severity: 2 })).status).toBe(
      'investigating',
    );
    await write.api.changeIncident(ID, ID, { status: 'mitigating' });
    const timeline = harness({ data: [], nextCursor: null });
    await timeline.api.incidentUpdates(ID, ID);
    await timeline.api.incidentUpdates(ID, ID, 'u1');
    expect(
      [...read.calls, ...write.calls, ...timeline.calls].map((call) => [
        call.method,
        call.url,
        call.body,
      ]),
    ).toEqual([
      ['GET', `/api/channels/${ID}/incident`, undefined],
      ['POST', `/api/channels/${ID}/incident`, { id: ID, severity: 2 }],
      ['PATCH', `/api/channels/${ID}/incident/${ID}`, { status: 'mitigating' }],
      ['GET', `/api/channels/${ID}/incident/${ID}/updates`, undefined],
      ['GET', `/api/channels/${ID}/incident/${ID}/updates?before=u1`, undefined],
    ]);
    const respond = harness(incident);
    await respond.api.respond(ID, ID, 'u2', true);
    await respond.api.respond(ID, ID, 'u2', false);
    expect(respond.calls.map((call) => [call.method, call.url])).toEqual([
      ['PUT', `/api/channels/${ID}/incident/${ID}/responders/u2`],
      ['DELETE', `/api/channels/${ID}/incident/${ID}/responders/u2`],
    ]);
    const postmortem = harness(incident);
    await postmortem.api.savePostmortem(ID, ID, { content: 'what happened', version: 2 });
    expect(postmortem.calls.map((call) => [call.method, call.url, call.body])).toEqual([
      [
        'PUT',
        `/api/channels/${ID}/incident/${ID}/postmortem`,
        { content: 'what happened', version: 2 },
      ],
    ]);
    // What the server answers is parsed against the contract: a resolved one with no instant is not one.
    const broken = harness({ ...incident, status: 'resolved' });
    expect(
      await broken.api.changeIncident(ID, ID, { status: 'resolved' }).then(
        () => 'parsed',
        () => 'refused',
      ),
    ).toBe('refused');
  });

  test('a channel’s files, a page at a time (D-129)', async () => {
    const list = harness({ data: [], nextCursor: null });
    await list.api.files(ID);
    await list.api.files(ID, 'f1');
    expect(list.calls.map((call) => [call.method, call.url])).toEqual([
      ['GET', `/api/channels/${ID}/files`],
      ['GET', `/api/channels/${ID}/files?before=f1`],
    ]);
  });

  test('a star on a channel, and letting it go (D-132)', async () => {
    const call = harness(null);
    await call.api.star(ID, true);
    await call.api.star(ID, false);
    expect(call.calls.map((c) => [c.method, c.url])).toEqual([
      ['PUT', `/api/channels/${ID}/star`],
      ['DELETE', `/api/channels/${ID}/star`],
    ]);
  });

  test('following a thread is read and set on its root, and the answer is checked (D-161)', async () => {
    const call = harness({ following: false });
    expect(await call.api.threadFollow(ID)).toEqual({ following: false });
    expect(await call.api.setThreadFollow(ID, false)).toEqual({ following: false });
    expect(call.calls).toEqual([
      { method: 'GET', url: `/api/messages/${ID}/follow`, body: undefined },
      { method: 'PUT', url: `/api/messages/${ID}/follow`, body: { following: false } },
    ]);
    const wrong = harness({ following: 'yes' });
    expect(
      await wrong.api.threadFollow(ID).then(
        () => 'parsed',
        () => 'refused',
      ),
    ).toBe('refused');
  });

  test('channels, joining, direct messages and the read position', async () => {
    const list = harness([channel]);
    await list.api.channels(ID);
    expect(list.calls[0]?.url).toBe(`/api/workspaces/${ID}/channels`);

    const create = harness(channel);
    await create.api.createChannel(ID, { name: 'api', topic: 'x' });
    expect(create.calls[0]).toMatchObject({ method: 'POST', body: { name: 'api', topic: 'x' } });
    await create.api.joinChannel(ID);
    expect(create.calls[1]).toMatchObject({ method: 'POST', url: `/api/channels/${ID}/join` });
    await create.api.openDirectMessage(ID, 'u1');
    expect(create.calls[2]).toMatchObject({
      url: `/api/workspaces/${ID}/dms`,
      body: { userId: 'u1' },
    });

    const read = harness(state);
    await read.api.markRead(ID, 'm1');
    expect(read.calls[0]).toMatchObject({
      method: 'PUT',
      url: `/api/channels/${ID}/read`,
      body: { lastReadMessageId: 'm1' },
    });
  });

  test('messages, threads and the open questions page by cursor', async () => {
    const page = harness({ data: [message], nextCursor: null });
    await page.api.messages(ID, { before: 'b', limit: 25 });
    expect(page.calls[0]?.url).toBe(`/api/channels/${ID}/messages?before=b&limit=25`);
    await page.api.messages(ID);
    expect(page.calls[1]?.url).toBe(`/api/channels/${ID}/messages`);
    await page.api.thread(ID, { after: 'a' });
    expect(page.calls[2]?.url).toBe(`/api/messages/${ID}/thread?after=a`);
    await page.api.unresolved(ID, { before: 'b' });
    expect(page.calls[3]?.url).toBe(`/api/workspaces/${ID}/unresolved?before=b`);
    await page.api.unresolved(ID);
    await page.api.thread(ID);
    expect(page.calls[4]?.url).toBe(`/api/workspaces/${ID}/unresolved`);
    expect(page.calls[5]?.url).toBe(`/api/messages/${ID}/thread`);

    const sent = harness(message);
    await sent.api.send(ID, { id: ID, content: 'hi', parentId: ID });
    expect(sent.calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/channels/${ID}/messages`,
      body: { id: ID, content: 'hi', parentId: ID },
    });
  });

  test('the inbox: the workspace in the query, reading in the body, and the answer read against the contract', async () => {
    const notification = {
      id: ID,
      type: 'mention',
      channelId: ID,
      message,
      thread: null,
      createdAt: WHEN,
      readAt: null,
    };
    const inbox = harness({ data: [notification], nextCursor: null });
    const page = await inbox.api.notifications(ID, { before: 'b' });
    expect(page.data[0]?.type).toBe('mention');
    await inbox.api.notifications(ID);
    expect(inbox.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET /api/notifications?workspaceId=${ID}&before=b`,
      `GET /api/notifications?workspaceId=${ID}`,
    ]);
    await inbox.api.notifications(ID, {
      types: 'thread_reply,thread_resolved',
      unreadOnly: true,
      limit: 2,
    });
    expect(inbox.calls.at(-1)?.url).toBe(
      `/api/notifications?workspaceId=${ID}&types=thread_reply%2Cthread_resolved&limit=2&unreadOnly=true`,
    );
    await inbox.api.readNotifications({ ids: [ID] });
    await inbox.api.readNotifications({ workspaceId: ID, before: ID });
    await inbox.api.readThread(ID, ID);
    expect(inbox.calls.slice(3)).toEqual([
      { method: 'PUT', url: '/api/notifications/read', body: { ids: [ID] } },
      { method: 'PUT', url: '/api/notifications/read', body: { workspaceId: ID, before: ID } },
      { method: 'PUT', url: `/api/messages/${ID}/thread/read`, body: { lastReadMessageId: ID } },
    ]);
    // A row the contract does not describe is refused, not shown.
    const wrong = harness({ data: [{ ...notification, type: 'everyone' }], nextCursor: null });
    let refused = false;
    await wrong.api.notifications(ID).catch(() => {
      refused = true;
    });
    expect(refused).toBe(true);
  });

  test('Deep Work goes in the body, to the workspace it is for, and its answer is read', async () => {
    const set = harness({ until: null });
    expect(await set.api.setDeepWork(ID, { active: false })).toEqual({ until: null });
    expect(set.calls).toEqual([
      { method: 'PUT', url: `/api/workspaces/${ID}/deep-work`, body: { active: false } },
    ]);
  });

  test('an invitation’s token goes in the body, never the path, and each answer is read (D-115)', async () => {
    const token = 'd'.repeat(64);
    const preview = { workspace, expiresAt: WHEN, member: false };
    const previewed = harness(preview);
    expect(await previewed.api.previewInvitation(token)).toEqual(preview);
    const membership = { workspace, role: 'member' as const, joinedAt: WHEN, deepWorkUntil: null };
    const accepted = harness(membership);
    expect(await accepted.api.acceptInvitation(token)).toEqual(membership);
    expect([...previewed.calls, ...accepted.calls]).toEqual([
      { method: 'POST', url: '/api/invitations/preview', body: { token } },
      { method: 'POST', url: '/api/invitations/accept', body: { token } },
    ]);
  });

  test('an owner’s invitation links: made, listed by cursor, revoked by id (D-115)', async () => {
    const invitation = { id: ID, createdBy: user, createdAt: WHEN, expiresAt: WHEN };
    const made = harness({ invitation, token: 'd'.repeat(64) });
    await made.api.createInvitation(ID);
    const listed = harness({ data: [invitation], nextCursor: null });
    await listed.api.invitations(ID, ID);
    await listed.api.invitations(ID);
    const revoked = harness(null);
    await revoked.api.revokeInvitation(ID, ID);
    expect([...made.calls, ...listed.calls, ...revoked.calls]).toEqual([
      { method: 'POST', url: `/api/workspaces/${ID}/invitations`, body: {} },
      { method: 'GET', url: `/api/workspaces/${ID}/invitations?before=${ID}`, body: undefined },
      { method: 'GET', url: `/api/workspaces/${ID}/invitations`, body: undefined },
      { method: 'DELETE', url: `/api/workspaces/${ID}/invitations/${ID}`, body: undefined },
    ]);
  });

  test('the audit trail is read newest first, older pages by the cursor, narrowed by its filter (D-26, D-222)', async () => {
    const entry = {
      id: ID,
      actor: user,
      action: 'channel.created',
      targetType: 'channel',
      targetId: ID,
      metadata: {},
      createdAt: WHEN,
    };
    const read = harness({ data: [entry], nextCursor: null });
    expect(await read.api.audit(ID, {})).toEqual({ data: [entry], nextCursor: null });
    await read.api.audit(ID, {}, ID);
    await read.api.audit(
      ID,
      { actorId: ID, action: 'member.removed', from: '2026-10-01T00:00:00.000Z' },
      ID,
    );
    expect(read.calls).toEqual([
      { method: 'GET', url: `/api/workspaces/${ID}/audit`, body: undefined },
      { method: 'GET', url: `/api/workspaces/${ID}/audit?before=${ID}`, body: undefined },
      {
        method: 'GET',
        url: `/api/workspaces/${ID}/audit?actorId=${ID}&action=member.removed&from=2026-10-01T00%3A00%3A00.000Z&before=${ID}`,
        body: undefined,
      },
    ]);
  });

  test('a member’s role is sent in the body and the member read back; removing is by id (§7.4)', async () => {
    const member = { user, role: 'admin' as const, joinedAt: WHEN, profile: NO_PROFILE };
    const changed = harness(member);
    expect(await changed.api.updateMemberRole(ID, ID, 'admin')).toEqual(member);
    const removed = harness(null);
    await removed.api.removeMember(ID, ID);
    expect([...changed.calls, ...removed.calls]).toEqual([
      { method: 'PATCH', url: `/api/workspaces/${ID}/members/${ID}`, body: { role: 'admin' } },
      { method: 'DELETE', url: `/api/workspaces/${ID}/members/${ID}`, body: undefined },
    ]);
  });

  test('the GitHub token: its status read, the token sent in the body, and taken away (D-23)', async () => {
    const status = { configured: true, updatedAt: WHEN, invalidSince: null, broadScopes: false };
    const read = harness(status);
    expect(await read.api.githubIntegration(ID)).toEqual(status);
    const saved = harness(null);
    await saved.api.setGitHubToken(ID, 'github_pat_x');
    const removed = harness(null);
    await removed.api.removeGitHubToken(ID);
    expect([...read.calls, ...saved.calls, ...removed.calls]).toEqual([
      { method: 'GET', url: `/api/workspaces/${ID}/integrations/github`, body: undefined },
      {
        method: 'PUT',
        url: `/api/workspaces/${ID}/integrations/github`,
        body: { token: 'github_pat_x' },
      },
      { method: 'DELETE', url: `/api/workspaces/${ID}/integrations/github`, body: undefined },
    ]);
  });

  test('the GitHub App: status read, each trip started at its own route, installation and authorization let go (D-246)', async () => {
    const status = { available: true, installation: null, authorization: null };
    const redirect = { url: 'https://github.example/x' };
    const read = harness(status);
    expect(await read.api.githubApp(ID)).toEqual(status);
    const install = harness(redirect);
    expect(await install.api.startGitHubInstallation(ID)).toEqual(redirect);
    const authorize = harness(redirect);
    expect(await authorize.api.startGitHubAuthorization('/w/acme')).toEqual(redirect);
    const gone = harness(null);
    await gone.api.removeGitHubInstallation(ID);
    await gone.api.forgetGitHubAuthorization();
    expect([...read.calls, ...install.calls, ...authorize.calls, ...gone.calls]).toEqual([
      { method: 'GET', url: `/api/workspaces/${ID}/github-app`, body: undefined },
      { method: 'POST', url: `/api/workspaces/${ID}/github-app/installation`, body: undefined },
      { method: 'POST', url: '/api/github-app/authorization', body: { returnTo: '/w/acme' } },
      { method: 'DELETE', url: `/api/workspaces/${ID}/github-app/installation`, body: undefined },
      { method: 'DELETE', url: '/api/github-app/authorization', body: undefined },
    ]);
  });

  test('making an issue: the repositories read, the request sent whole and its outcome checked (D-246)', async () => {
    const list = harness({ repositories: [{ id: 77, fullName: 'acme/api', private: true }] });
    expect((await list.api.githubRepositories(ID)).repositories).toHaveLength(1);
    const request = {
      clientRequestId: ID,
      repositoryId: 77,
      title: 'Retry',
      body: 'Why',
      copyPrivateText: false,
    };
    const made = harness({ status: 'unknown' });
    expect(await made.api.createGitHubIssue(ID, request)).toEqual({ status: 'unknown' });
    expect([...list.calls, ...made.calls]).toEqual([
      { method: 'GET', url: `/api/workspaces/${ID}/github-repositories`, body: undefined },
      { method: 'POST', url: `/api/messages/${ID}/github-issue`, body: request },
    ]);
  });

  test('pointing a thread at work that exists: the address sent and the link read (D-246)', async () => {
    const work = {
      id: ID,
      repository: 'acme/api',
      kind: 'issue' as const,
      number: 1,
      title: 'Retry',
      state: 'open' as const,
      origin: 'linked' as const,
      url: 'https://github.com/acme/api/issues/1',
    };
    const linked = harness(work);
    expect(await linked.api.linkGitHubWork(ID, { url: work.url })).toEqual(work);
    expect(linked.calls).toEqual([
      { method: 'POST', url: `/api/messages/${ID}/github-link`, body: { url: work.url } },
    ]);
  });

  test('a channel’s repository feeds: listed, connected with its body, disconnected (D-134)', async () => {
    const feed = {
      id: ID,
      channelId: ID,
      repository: 'acme/api',
      events: ['push' as const],
      createdAt: WHEN,
      lastDeliveryAt: null,
      lastFailure: null,
    };
    const list = harness([feed]);
    expect(await list.api.githubFeeds(ID)).toEqual([feed]);
    const made = { feed, webhookPath: `/api/webhooks/github/${ID}`, secret: 'a'.repeat(64) };
    const connect = harness(made);
    expect(
      await connect.api.connectGitHubFeed(ID, { repository: 'acme/api', events: ['push'] }),
    ).toEqual(made);
    const remove = harness(null);
    await remove.api.disconnectGitHubFeed(ID, ID);
    expect([...list.calls, ...connect.calls, ...remove.calls]).toEqual([
      { method: 'GET', url: `/api/channels/${ID}/github-feeds`, body: undefined },
      {
        method: 'POST',
        url: `/api/channels/${ID}/github-feeds`,
        body: { repository: 'acme/api', events: ['push'] },
      },
      { method: 'DELETE', url: `/api/channels/${ID}/github-feeds/${ID}`, body: undefined },
    ]);
    // A secret that is not the contract's is never believed.
    const refused = await harness({ ...made, secret: 'short' })
      .api.connectGitHubFeed(ID, { repository: 'acme/api', events: ['push'] })
      .then(
        () => 'believed',
        (error: unknown) => (error instanceof ApiError ? error.code : 'not an ApiError'),
      );
    expect(refused).toBe('MALFORMED');
  });

  test('an unfurl names the workspace and the link in the body, and reads a card or none (D-112)', async () => {
    const url = 'https://github.com/purlay/purlay/pull/1';
    const none = harness(null);
    expect(await none.api.unfurl(ID, url)).toBeNull();
    expect(none.calls).toEqual([
      { method: 'POST', url: '/api/integrations/github/unfurl', body: { workspaceId: ID, url } },
    ]);
  });

  test('the notification level goes in the body, to the channel it is for', async () => {
    const set = harness(null);
    await set.api.setNotificationLevel(ID, 'none');
    expect(set.calls).toEqual([
      { method: 'PUT', url: `/api/channels/${ID}/notification-level`, body: { level: 'none' } },
    ]);
  });

  test('search: the words and the cursor in the query', async () => {
    const found = harness({ data: [message], nextCursor: null });
    await found.api.search(ID, { q: 'a b&c' });
    await found.api.search(ID, { q: 'deploy', before: 'b' });
    expect(found.calls.map((c) => c.url)).toEqual([
      `/api/workspaces/${ID}/search?q=a+b%26c`,
      `/api/workspaces/${ID}/search?q=deploy&before=b`,
    ]);
  });

  test('resolution and reactions, the emoji percent-encoded into the path', async () => {
    const msg = harness(message);
    await msg.api.resolve(ID);
    await msg.api.reopen(ID);
    expect(msg.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `POST /api/messages/${ID}/resolve`,
      `DELETE /api/messages/${ID}/resolve`,
    ]);

    const reactions = harness({ reactions: [{ emoji: '👍', userIds: [ID] }] });
    await reactions.api.react(ID, '👍');
    await reactions.api.unreact(ID, '👍');
    expect(reactions.calls[0]?.url).toBe(`/api/messages/${ID}/reactions/%F0%9F%91%8D`);
    expect(reactions.calls[1]).toMatchObject({ method: 'DELETE' });
  });

  test('a channel’s settings: a rename and a topic in the body, then leave, archive and who is in it (D-123)', async () => {
    const renamed = harness({ ...channel, name: 'genel-sohbet' });
    expect((await renamed.api.updateChannel(ID, { name: 'genel-sohbet', topic: null })).name).toBe(
      'genel-sohbet',
    );
    const done = harness(null);
    await done.api.leaveChannel(ID);
    await done.api.archiveChannel(ID);
    const listed = harness([
      {
        user: { id: ID, username: 'a', displayName: 'A', avatarUrl: null },
        joinedAt: '2026-09-09T08:00:00.000Z',
        profile: NO_PROFILE,
      },
    ]);
    expect(await listed.api.channelMembers(ID)).toHaveLength(1);
    expect([...renamed.calls, ...done.calls, ...listed.calls]).toMatchObject([
      { method: 'PATCH', url: `/api/channels/${ID}`, body: { name: 'genel-sohbet', topic: null } },
      { method: 'POST', url: `/api/channels/${ID}/leave` },
      { method: 'DELETE', url: `/api/channels/${ID}` },
      { method: 'GET', url: `/api/channels/${ID}/members` },
    ]);
  });

  test('archived channels are read for the workspace and restored by the channel (D-232)', async () => {
    const archived = {
      id: ID,
      name: 'old-launch',
      type: 'public',
      archivedAt: '2026-10-30T08:00:00.000Z',
    };
    const listed = harness([archived]);
    expect(await listed.api.archivedChannels(ID)).toEqual([archived] as never);
    const restored = harness(null);
    await restored.api.restoreChannel(ID);
    expect([...listed.calls, ...restored.calls]).toMatchObject([
      { method: 'GET', url: `/api/workspaces/${ID}/archived-channels` },
      { method: 'POST', url: `/api/channels/${ID}/restore` },
    ]);
  });

  test('bringing somebody into a channel names them, and reads no answer', async () => {
    const added = harness(null);
    await added.api.addChannelMember(ID, ID);
    expect(added.calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/channels/${ID}/members`,
      body: { userId: ID },
    });
  });

  test('taking somebody out of a channel names them in the path, and reads no answer (D-172)', async () => {
    const removed = harness(null);
    await removed.api.removeChannelMember(ID, ID);
    expect(removed.calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/api/channels/${ID}/members/${ID}`,
    });
  });

  test('an upload is the file’s bytes to its workspace, with the id and the name in the query, its progress told as a fraction, read as an attachment', async () => {
    const attachment: Attachment = {
      id: ID,
      fileName: 'a b.png',
      mimeType: 'image/webp',
      sizeBytes: 3,
      kind: 'image',
      width: 1,
      height: 1,
    };
    /** Answers as soon as it is sent, after telling half and then all of the body. */
    const answering =
      (body: unknown, opened: string[]): (() => UploadRequest) =>
      () => {
        const request: UploadRequest = {
          upload: { onprogress: null },
          onload: null,
          onerror: null,
          status: 201,
          responseText: JSON.stringify(body),
          open: (_method, url) => {
            opened.push(url);
          },
          setRequestHeader: () => undefined,
          send: () => {
            request.upload.onprogress?.({
              lengthComputable: true,
              loaded: 3,
              total: 6,
            } as ProgressEvent);
            request.upload.onprogress?.({
              lengthComputable: true,
              loaded: 6,
              total: 6,
            } as ProgressEvent);
            request.onload?.({ type: 'load' } as ProgressEvent);
          },
        };
        return request;
      };
    const opened: string[] = [];
    const told: number[] = [];
    const api = createApi(
      createHttp(() => Promise.reject(new Error('no fetch')), answering(attachment, opened)),
    );
    const answer = await api.upload(
      ID,
      { id: ID, name: 'a b.png', file: new Blob([new Uint8Array([1, 2, 3])]) },
      (fraction) => {
        told.push(fraction);
      },
    );
    expect(answer).toEqual(attachment);
    expect(opened).toEqual([`/api/workspaces/${ID}/uploads?id=${ID}&name=a+b.png`]);
    expect(told).toEqual([0.5, 1]);
    // An answer that is not an attachment is not believed; no listener, nothing told.
    const odd = createApi(
      createHttp(() => Promise.reject(new Error('no fetch')), answering({ id: ID }, [])),
    );
    const thrown = await odd
      .upload(ID, { id: ID, name: 'x', file: new Blob([]) })
      .catch((e: unknown) => e);
    expect(thrown).toMatchObject({ code: 'MALFORMED' });
  });

  test('an edit sends the new words; a delete asks and reads no answer', async () => {
    const edited = harness(message);
    await edited.api.editMessage(ID, 'better words');
    expect(edited.calls[0]).toMatchObject({
      method: 'PATCH',
      url: `/api/messages/${ID}`,
      body: { content: 'better words' },
    });
    const gone = harness(null);
    await gone.api.deleteMessage(ID);
    expect(gone.calls[0]).toMatchObject({ method: 'DELETE', url: `/api/messages/${ID}` });
  });

  test('signing out asks and does not read an answer', async () => {
    const out = harness(null);
    await out.api.signOut();
    expect(out.calls[0]).toMatchObject({ method: 'POST', url: '/auth/logout' });
    const everywhere = harness(null);
    await everywhere.api.signOutEverywhere();
    expect(everywhere.calls[0]).toMatchObject({ method: 'POST', url: '/auth/logout-all' });
  });

  test('the ways the caller signs in, read only (D-176, D-179 §5)', async () => {
    const read = harness({
      email: 'a@example.test',
      emailLinks: true,
      hasPassword: false,
      github: null,
      oidc: false,
      twoFactor: false,
      twoFactorRequired: false,
    });
    expect(await read.api.mySignIn()).toEqual({
      email: 'a@example.test',
      emailLinks: true,
      hasPassword: false,
      github: null,
      oidc: false,
      twoFactor: false,
      twoFactorRequired: false,
    });
    expect(read.calls[0]).toMatchObject({ method: 'GET', url: '/api/me/sign-in' });
  });

  test('where the caller is signed in, and ending one of those sessions by its id (D-193)', async () => {
    const session: DeviceSession = {
      id: ID,
      kind: 'native',
      name: 'Ada’s MacBook',
      createdAt: '2026-09-09T08:00:00.000Z',
      lastUsedAt: '2026-09-10T08:00:00.000Z',
      expiresAt: '2026-10-09T08:00:00.000Z',
      current: false,
    };
    const read = harness({ data: [session] });
    expect(await read.api.mySessions()).toEqual({ data: [session] });
    expect(read.calls[0]).toMatchObject({ method: 'GET', url: '/api/me/sessions' });
    const ended = harness(null);
    await ended.api.endMySession(ID);
    expect(ended.calls[0]).toMatchObject({ method: 'DELETE', url: `/api/me/sessions/${ID}` });
  });

  test('authorising the native application (D-191): the challenge and state go up, the fixed address comes back', async () => {
    const authorised = harness({ redirect: 'purlay://auth?code=c&state=s' });
    const input = { challenge: 'a'.repeat(43), state: 'b'.repeat(22) };
    expect(await authorised.api.authorizeNative(input)).toEqual({
      redirect: 'purlay://auth?code=c&state=s',
    });
    expect(authorised.calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/native/authorize',
      body: input,
    });
  });

  test('signing in by email (D-138): what is offered, asking, showing and spending a link', async () => {
    const methods = harness({
      github: false,
      email: true,
      oidc: null,
      signUp: 'open',
      password: true,
    });
    expect(await methods.api.authMethods()).toEqual({
      github: false,
      email: true,
      oidc: null,
      signUp: 'open',
      password: true,
    });
    expect(methods.calls[0]).toMatchObject({ method: 'GET', url: '/api/auth/methods' });

    const token = 'a'.repeat(64);
    const asked = harness(null);
    await asked.api.requestEmailSignIn({
      email: 'a@example.test',
      locale: 'tr',
      invitation: token,
    });
    expect(asked.calls[0]).toEqual({
      method: 'POST',
      url: '/auth/email',
      body: { email: 'a@example.test', locale: 'tr', invitation: token },
    });

    const shown = harness({ email: 'a@example.test' });
    expect(await shown.api.previewEmailSignIn(token)).toEqual({ email: 'a@example.test' });
    expect(shown.calls[0]).toEqual({ method: 'POST', url: '/auth/email/preview', body: { token } });

    const spent = harness(null);
    await spent.api.consumeEmailSignIn(token);
    expect(spent.calls[0]).toEqual({ method: 'POST', url: '/auth/email/consume', body: { token } });
  });

  test('passwords and the invitation passport (R30, R51)', async () => {
    const signedIn = harness({ token: 'unread' });
    expect(await signedIn.api.signInWithPassword({ email: 'a@example.test', password: 'pw' })).toBe(
      'signed-in',
    );
    expect(signedIn.calls[0]).toEqual({
      method: 'POST',
      url: '/auth/sign-in/email',
      body: { email: 'a@example.test', password: 'pw' },
    });

    // Every other session ends with a change; the client always asks for it.
    const changed = harness({ token: 'unread' });
    await changed.api.changePassword({ currentPassword: 'old', newPassword: 'new' });
    expect(changed.calls[0]).toEqual({
      method: 'POST',
      url: '/auth/change-password',
      body: { currentPassword: 'old', newPassword: 'new', revokeOtherSessions: true },
    });

    const token = 'b'.repeat(64);
    const passport = harness(null);
    await passport.api.openInvitationPassport({ token });
    await passport.api.openInvitationPassport({ token, email: 'a@example.test' });
    expect(passport.calls.map((call) => [call.url, call.body])).toEqual([
      ['/api/invitations/passport', { token }],
      ['/api/invitations/passport', { token, email: 'a@example.test' }],
    ]);
  });

  test('two-step verification (D-236): the library’s routes, and what each answer means', async () => {
    const asked = harness({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
    expect(await asked.api.signInWithPassword({ email: 'a@example.test', password: 'pw' })).toBe(
      'second-step',
    );

    const verified = harness({ token: 'unread' });
    await verified.api.verifySignInCode({ code: '123456', kind: 'app' });
    await verified.api.verifySignInCode({ code: 'abcde-12345', kind: 'backup' });
    expect(verified.calls.map((call) => [call.url, call.body])).toEqual([
      ['/auth/two-factor/verify-totp', { code: '123456' }],
      ['/auth/two-factor/verify-backup-code', { code: 'abcde-12345' }],
    ]);

    const enrolment = { totpURI: 'otpauth://totp/x?secret=AAAA', backupCodes: ['a-b'] };
    const started = harness(enrolment);
    expect(await started.api.startTwoFactor('pw')).toEqual(enrolment);
    expect(started.calls[0]).toEqual({
      method: 'POST',
      url: '/auth/two-factor/enable',
      body: { password: 'pw' },
    });

    const confirmed = harness({ token: 'unread' });
    await confirmed.api.confirmTwoFactor('123456');
    expect(confirmed.calls[0]).toMatchObject({
      url: '/auth/two-factor/verify-totp',
      body: { code: '123456' },
    });

    const stopped = harness({ status: true });
    await stopped.api.stopTwoFactor('pw');
    expect(stopped.calls[0]).toMatchObject({
      url: '/auth/two-factor/disable',
      body: { password: 'pw' },
    });

    const renewed = harness({ status: true, backupCodes: ['c-d'] });
    expect((await renewed.api.newBackupCodes('pw')).backupCodes).toEqual(['c-d']);
    expect(renewed.calls[0]).toMatchObject({
      url: '/auth/two-factor/generate-backup-codes',
      body: { password: 'pw' },
    });
  });

  test('how long a workspace keeps its history (D-139 §4): read, and set', async () => {
    const read = harness({ retentionDays: null, channelsKeptLonger: 0 });
    expect(await read.api.retention(ID)).toEqual({ retentionDays: null, channelsKeptLonger: 0 });
    expect(read.calls[0]).toMatchObject({ method: 'GET', url: `/api/workspaces/${ID}/retention` });
    const set = harness({ retentionDays: 90, channelsKeptLonger: 0 });
    expect(await set.api.setRetention(ID, 90)).toEqual({
      retentionDays: 90,
      channelsKeptLonger: 0,
    });
    expect(set.calls[0]).toEqual({
      method: 'PUT',
      url: `/api/workspaces/${ID}/retention`,
      body: { retentionDays: 90 },
    });
  });

  test('how long a channel keeps its history (D-225): read, and set', async () => {
    const answer = { keepsAtLeast: 'forever', workspaceDays: 30, effectiveDays: null } as const;
    const read = harness(answer);
    expect(await read.api.channelRetention(ID)).toEqual(answer);
    expect(read.calls[0]).toMatchObject({ method: 'GET', url: `/api/channels/${ID}/retention` });
    const set = harness(answer);
    expect(await set.api.setChannelRetention(ID, 'forever')).toEqual(answer);
    expect(set.calls[0]).toEqual({
      method: 'PUT',
      url: `/api/channels/${ID}/retention`,
      body: { keepsAtLeast: 'forever' },
    });
  });

  test('a workspace’s storage and its quota (D-173): read', async () => {
    const read = harness({ usedBytes: 1024, quotaBytes: 5 * 1024 ** 3 });
    expect(await read.api.storage(ID)).toEqual({ usedBytes: 1024, quotaBytes: 5 * 1024 ** 3 });
    expect(read.calls[0]).toMatchObject({ method: 'GET', url: `/api/workspaces/${ID}/storage` });
  });

  test('an owner’s exports (D-140): listed, and one asked for', async () => {
    const one = {
      id: '0199155c-6200-7b7f-8c11-0000000000e1',
      status: 'pending' as const,
      createdAt: '2026-10-14T10:00:00.000Z',
      finishedAt: null,
      expiresAt: null,
      sizeBytes: null,
      failure: null,
    };
    const listed = harness([one]);
    expect(await listed.api.exports(ID)).toEqual([one]);
    expect(listed.calls[0]).toMatchObject({ method: 'GET', url: `/api/workspaces/${ID}/exports` });
    const asked = harness(one);
    expect(await asked.api.requestExport(ID)).toEqual(one);
    expect(asked.calls[0]).toMatchObject({ method: 'POST', url: `/api/workspaces/${ID}/exports` });
  });

  test('one’s own data (D-241): exports listed, and one asked for, in no workspace', async () => {
    const one = {
      id: '0199155c-6200-7b7f-8c11-0000000000f1',
      status: 'pending' as const,
      createdAt: '2026-10-14T10:00:00.000Z',
      finishedAt: null,
      expiresAt: null,
      sizeBytes: null,
      failure: null,
    };
    const listed = harness([one]);
    expect(await listed.api.myExports()).toEqual([one]);
    expect(listed.calls[0]).toMatchObject({ method: 'GET', url: '/api/me/exports' });
    const asked = harness(one);
    expect(await asked.api.requestMyExport()).toEqual(one);
    expect(asked.calls[0]).toMatchObject({ method: 'POST', url: '/api/me/exports' });
  });

  test('quiet hours and missed mail: read and set, as the person’s own (D-234, D-240)', async () => {
    const quiet = {
      quietHours: { from: 1320, to: 420, days: [1, 2] },
      timeZone: 'Europe/Istanbul',
    };
    const readQuiet = harness(quiet);
    expect(await readQuiet.api.quietHours()).toEqual(quiet);
    expect(readQuiet.calls[0]).toMatchObject({ method: 'GET', url: '/api/me/quiet-hours' });
    const setQuiet = harness(quiet);
    expect(await setQuiet.api.setQuietHours({ quietHours: quiet.quietHours })).toEqual(quiet);
    expect(setQuiet.calls[0]).toMatchObject({ method: 'PUT', url: '/api/me/quiet-hours' });

    const mail = { on: true, available: true };
    const readMail = harness(mail);
    expect(await readMail.api.missedMail()).toEqual(mail);
    expect(readMail.calls[0]).toMatchObject({ method: 'GET', url: '/api/me/missed-mail' });
    const setMail = harness(mail);
    expect(await setMail.api.setMissedMail({ on: true })).toEqual(mail);
    expect(setMail.calls[0]).toMatchObject({ method: 'PUT', url: '/api/me/missed-mail' });
    const stopped = harness(null);
    await stopped.api.stopMissedMail('a'.repeat(64));
    expect(stopped.calls[0]).toMatchObject({ method: 'POST', url: '/api/missed-mail/stop' });
  });

  test('erasing one’s own account sends the username typed (D-139 §5)', async () => {
    const erased = harness(null);
    await erased.api.eraseAccount('alice');
    expect(erased.calls[0]).toEqual({
      method: 'POST',
      url: '/api/me/erase',
      body: { confirm: 'alice' },
    });
  });

  test('a channel’s bookmarks: listed, one added with its address and title in the body, one let go by id (D-218)', async () => {
    const bookmark = {
      id: ID,
      channelId: ID,
      url: 'https://example.test/runbook',
      title: 'Runbook',
      addedBy: user,
      addedAt: WHEN,
    };
    const list = harness([bookmark]);
    expect(await list.api.bookmarks(ID)).toEqual([bookmark]);
    expect(list.calls[0]).toMatchObject({ method: 'GET', url: `/api/channels/${ID}/bookmarks` });

    const add = harness(bookmark);
    const input = { url: 'https://example.test/runbook', title: 'Runbook' };
    expect(await add.api.addBookmark(ID, input)).toEqual(bookmark);
    expect(add.calls[0]).toEqual({
      method: 'POST',
      url: `/api/channels/${ID}/bookmarks`,
      body: input,
    });

    const remove = harness(null);
    await remove.api.removeBookmark(ID, ID);
    expect(remove.calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/api/channels/${ID}/bookmarks/${ID}`,
    });
  });

  test('a bookmark list that breaks the contract is refused, not shown', async () => {
    const broken = harness([{ id: ID, channelId: ID, url: 'not a link', title: '' }]);
    const failure = await broken.api.bookmarks(ID).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiError);
  });

  test('marking unread names the message it is unread from, and reads the new position (D-212)', async () => {
    const unread = harness({ ...state, lastReadMessageId: ID, unreadCount: 3 });
    expect((await unread.api.markUnread(ID, 'm2')).unreadCount).toBe(3);
    expect(unread.calls[0]).toEqual({
      method: 'PUT',
      url: `/api/channels/${ID}/unread`,
      body: { fromMessageId: 'm2' },
    });
  });

  test('marking every channel read names the workspace, sends nothing, and reads the states (D-238)', async () => {
    const all = harness({ data: [{ channelId: ID, state }] });
    expect((await all.api.markAllRead(ID)).data).toEqual([{ channelId: ID, state }]);
    expect(all.calls[0]).toEqual({
      method: 'PUT',
      url: `/api/workspaces/${ID}/read`,
      body: undefined,
    });
  });

  test('one message, and the window of messages around it, are read by its id', async () => {
    const one = harness(message);
    expect((await one.api.message(ID)).content).toBe('hi');
    expect(one.calls[0]).toMatchObject({ method: 'GET', url: `/api/messages/${ID}` });

    const around = harness({
      target: message,
      data: [message],
      olderCursor: null,
      newerCursor: ID,
    });
    const window = await around.api.messageWindow(ID);
    expect(window.target.id).toBe(ID);
    expect(window.newerCursor).toBe(ID);
    expect(around.calls[0]).toMatchObject({ method: 'GET', url: `/api/messages/${ID}/around` });
  });

  test('who is online in a workspace is read with the version everyone else is offline at (D-136)', async () => {
    const snapshot = { online: [{ userId: ID, online: true, version: 4 }], version: 4 };
    const presence = harness(snapshot);
    expect(await presence.api.presence(ID)).toEqual(snapshot);
    expect(presence.calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/workspaces/${ID}/presence`,
    });
  });

  test('leaving a workspace removes the caller’s own membership and reads no answer', async () => {
    const leave = harness(null);
    await leave.api.leaveWorkspace(ID);
    expect(leave.calls[0]).toMatchObject({
      method: 'DELETE',
      url: `/api/workspaces/${ID}/membership`,
    });
  });

  test('a text attachment is read as its words, not as JSON', async () => {
    const calls: string[] = [];
    const fetchFn = ((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('line one\nsatır iki', { status: 200 }));
    }) as unknown as typeof fetch;
    expect(await createApi(createHttp(fetchFn)).attachmentText(ID)).toBe('line one\nsatır iki');
    expect(calls).toEqual([`/api/attachments/${ID}`]);
  });

  test('whether the server is still waiting to be set up, and where it lives', async () => {
    const status = harness({ open: true, appUrl: 'https://purlay.example.test' });
    expect(await status.api.setupStatus()).toEqual({
      open: true,
      appUrl: 'https://purlay.example.test',
    });
    expect(status.calls[0]).toMatchObject({ method: 'GET', url: '/setup/status' });
  });

  test('an abandoned read carries the signal', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = ((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(new Response(JSON.stringify([channel]), { status: 200 }));
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await createApi(createHttp(fetchFn)).channels(ID, controller.signal);
    expect(signal).toBe(controller.signal);
  });
});
