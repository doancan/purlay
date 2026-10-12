/**
 * Every endpoint against the path `API.md` gives it, and the method and body the
 * contract says. The responses are real shapes, so the schema check in `http.ts`
 * is exercised too: an endpoint wired to the wrong schema fails here.
 */
import { describe, expect, test } from 'bun:test';
import type { Attachment } from '@purlay/types';
import { createApi, type Api } from './api';
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
  peer: null,
};
const message = {
  id: ID,
  channelId: ID,
  sender: user,
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
  test('identity and workspaces', async () => {
    const me = harness({
      user: { ...user, email: 'a@example.test' },
      memberships: [{ workspace, role: 'owner', joinedAt: WHEN, deepWorkUntil: null }],
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

    const members = harness([{ user, role: 'member', joinedAt: WHEN }]);
    await members.api.members(ID);
    expect(members.calls[0]?.url).toBe(`/api/workspaces/${ID}/members`);
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
    await inbox.api.readNotifications({ ids: [ID] });
    await inbox.api.readNotifications({ workspaceId: ID, before: ID });
    expect(inbox.calls.slice(2)).toEqual([
      { method: 'PUT', url: '/api/notifications/read', body: { ids: [ID] } },
      { method: 'PUT', url: '/api/notifications/read', body: { workspaceId: ID, before: ID } },
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

  test('the audit trail is read newest first, older pages by the cursor (D-26)', async () => {
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
    expect(await read.api.audit(ID)).toEqual({ data: [entry], nextCursor: null });
    await read.api.audit(ID, ID);
    expect(read.calls).toEqual([
      { method: 'GET', url: `/api/workspaces/${ID}/audit`, body: undefined },
      { method: 'GET', url: `/api/workspaces/${ID}/audit?before=${ID}`, body: undefined },
    ]);
  });

  test('a member’s role is sent in the body and the member read back; removing is by id (§7.4)', async () => {
    const member = { user, role: 'admin' as const, joinedAt: WHEN };
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
    const status = { configured: true, updatedAt: WHEN };
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

  test('bringing somebody into a channel names them, and reads no answer', async () => {
    const added = harness(null);
    await added.api.addChannelMember(ID, ID);
    expect(added.calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/channels/${ID}/members`,
      body: { userId: ID },
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
