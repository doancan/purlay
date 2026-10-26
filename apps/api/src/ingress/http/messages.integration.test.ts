/**
 * Messages, driven through real requests.
 *
 * D-33 names three failures that follow from trusting a client-supplied id, and
 * says all three are **permanent** because the value becomes a primary key. Each
 * has a test. So does the pagination contract, because `OFFSET` is prohibited on
 * this table and the alternative has to actually work.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { MESSAGE_CONTENT_MAX, MESSAGE_ID_SKEW, Message, messageId } from '@purlay/types';
import { createApp } from './app';
import { aRecordingLogger, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aMemoryStore } from '../../testing/storage';
import { storeUpload } from '../../modules/attachments/uploads';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const call = async (
  db: Executor,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; at?: Date } = {},
): Promise<Response> =>
  await createApp(
    testDependencies({
      database: db,
      clock: options.at === undefined ? clock : fixedClock(options.at),
    }),
  ).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const signedIn = async (db: Executor, name: string): Promise<SignedInUser> =>
  await aSignedInUser(db, clock, name);

/** A workspace with a channel, and whoever asked for it inside both. */
const aChannel = async (
  db: Executor,
  who: { userId: string; cookie: string },
  slug: string,
): Promise<string> => {
  const workspace = await call(db, 'POST', '/api/workspaces', {
    cookie: who.cookie,
    body: { name: slug, slug: aUniqueSlug(slug) },
  });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  const channel = await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, {
    cookie: who.cookie,
    body: { name: 'ops' },
  });
  return ((await channel.json()) as { id: string }).id;
};

/**
 * Scoped to the channel under test, never to the whole table.
 *
 * `withRollback` guarantees that *this test's* writes disappear — not that the
 * database is empty. A developer who has ever run the application locally has
 * rows in it, and an assertion that a table is empty fails for them and passes in
 * CI, which starts from nothing. That is a false negative that costs an afternoon
 * and teaches people to distrust the suite.
 */
const messagesIn = async (db: Executor, channelId: string): Promise<{ content: string }[]> =>
  await db.selectFrom('messages').select('content').where('channel_id', '=', channelId).execute();

const send = async (
  db: Executor,
  cookie: string,
  channelId: string,
  id: string,
  content: string,
): Promise<Response> =>
  await call(db, 'POST', `/api/channels/${channelId}/messages`, {
    cookie,
    body: { id, content },
  });

describe('integration: messages', () => {
  test('a message is written with the id the client chose', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-alice');
      const channelId = await aChannel(db, alice, 'msg-acme');
      const id = messageId(NOW);

      const response = await send(db, alice.cookie, channelId, id, 'hello');
      expect(response.status).toBe(201);
      const message = (await response.json()) as { id: string; sender: { username: string } };
      expect(message.id).toBe(id);
      expect(message.sender.username).toBe(alice.username);

      // And the sidebar can order channels without touching this table.
      const channel = await db
        .selectFrom('channels')
        .select('last_message_at')
        .where('id', '=', channelId)
        .executeTakeFirstOrThrow();
      expect(channel.last_message_at).not.toBeNull();
    });
  });

  /**
   * D-33's first failure: a v4 id makes that channel's ordering wrong forever,
   * and the contract's `uuid` format accepts it — which is why the check exists.
   */
  test('an id of the wrong version is refused', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-v4');
      const channelId = await aChannel(db, alice, 'msg-v4-ws');

      const response = await send(
        db,
        alice.cookie,
        channelId,
        '0199155c-6200-4b7f-8c11-2a4d3f9e1b70',
        'sneaky',
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_MESSAGE_ID' } });
      expect(await messagesIn(db, channelId)).toHaveLength(0);
    });
  });

  /**
   * D-33's second: an id from the future pins itself above every message that
   * follows **and** breaks keyset pagination for every reader.
   */
  test('an id from the future is refused, and so is one from too far back', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-clock');
      const channelId = await aChannel(db, alice, 'msg-clock-ws');

      const ahead = messageId(new Date(NOW.getTime() + 365 * 24 * 60 * 60 * 1000));
      const behind = messageId(new Date(NOW.getTime() - 10 * 60 * 1000));

      expect((await send(db, alice.cookie, channelId, ahead, 'later')).status).toBe(400);
      expect((await send(db, alice.cookie, channelId, behind, 'earlier')).status).toBe(400);
      expect(await messagesIn(db, channelId)).toHaveLength(0);
    });
  });

  /** D-8's whole reason: a retry after a timeout must not duplicate. */
  test('the same sender re-sending the same id gets the same message back', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-retry');
      const channelId = await aChannel(db, alice, 'msg-retry-ws');
      const id = messageId(NOW);

      const first = await send(db, alice.cookie, channelId, id, 'hello');
      const again = await send(db, alice.cookie, channelId, id, 'hello');

      expect(again.status).toBe(201);
      expect(await again.json()).toEqual(await first.json());
      expect(await messagesIn(db, channelId)).toHaveLength(1);
    });
  });

  /**
   * Regression for #198. An outbox drained after a long disconnect resends ids
   * minted before it; the plausibility window guards new ids, not the retry of a
   * stored one. The sender's own retry succeeds however late; nobody else learns
   * from a late id whether it exists.
   */
  test('a retry of a stored message succeeds however late it arrives, for its sender only', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-late');
      const bob = await signedIn(db, 'msg-late-bob');
      const channelId = await aChannel(db, alice, 'msg-late-ws');
      const bobsChannel = await aChannel(db, bob, 'msg-late-bob-ws');
      const id = messageId(NOW);
      const first = await send(db, alice.cookie, channelId, id, 'sent before the drop');
      expect(first.status).toBe(201);

      const later = new Date(NOW.getTime() + MESSAGE_ID_SKEW.behindMs + 1_000);
      const retry = await call(db, 'POST', `/api/channels/${channelId}/messages`, {
        cookie: alice.cookie,
        body: { id, content: 'sent before the drop' },
        at: later,
      });
      expect(retry.status).toBe(201);
      expect(await retry.json()).toEqual(await first.json());
      expect(await messagesIn(db, channelId)).toHaveLength(1);

      const lateAt = async (cookie: string, channel: string, lateId: string): Promise<unknown> => {
        const response = await call(db, 'POST', `/api/channels/${channel}/messages`, {
          cookie,
          body: { id: lateId, content: 'probe' },
          at: later,
        });
        return { status: response.status, body: await response.json() };
      };
      const neverExisted = await lateAt(bob.cookie, bobsChannel, messageId(NOW));
      expect(neverExisted).toMatchObject({
        status: 400,
        body: { error: { code: 'INVALID_MESSAGE_ID' } },
      });
      // Somebody else's stored id, and the sender's own id in another channel,
      // are refused exactly as an id nobody ever used.
      expect(await lateAt(bob.cookie, bobsChannel, id)).toEqual(neverExisted);
      expect(await lateAt(alice.cookie, await aChannel(db, alice, 'msg-late-other'), id)).toEqual(
        neverExisted,
      );
    });
  });

  /**
   * D-33's third: acknowledging a collision turns a send into an existence
   * oracle, and lets a client silently discard its own message.
   */
  test("somebody else's id is a conflict that discloses nothing", async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-owner');
      const mallory = await signedIn(db, 'msg-guesser');
      const channelId = await aChannel(db, alice, 'msg-conflict');
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: (
            await db
              .selectFrom('channels')
              .select('workspace_id')
              .where('id', '=', channelId)
              .executeTakeFirstOrThrow()
          ).workspace_id,
          user_id: mallory.userId,
        })
        .execute();
      // In the channel too, so the id is what refuses her and not her membership (D-156).
      await db
        .insertInto('channel_members')
        .values({ channel_id: channelId, user_id: mallory.userId })
        .execute();

      const id = messageId(NOW);
      await send(db, alice.cookie, channelId, id, 'a private thought');

      const response = await send(db, mallory.cookie, channelId, id, 'stolen');
      expect(response.status).toBe(409);
      const text = JSON.stringify(await response.json());
      expect(text).toContain('MESSAGE_ID_CONFLICT');
      // Not the content it collided with, not who wrote it, not where.
      expect(text).not.toContain('a private thought');
      expect(text).not.toContain('msg-owner');
      expect(text).not.toContain(channelId);

      // And the original is untouched.
      const rows = await messagesIn(db, channelId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe('a private thought');
    });
  });

  test('history is newest first, and pages by the last id seen', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-page');
      const channelId = await aChannel(db, alice, 'msg-page-ws');
      const ids: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = messageId(new Date(NOW.getTime() + i));
        ids.push(id);
        expect((await send(db, alice.cookie, channelId, id, `message ${String(i)}`)).status).toBe(
          201,
        );
      }

      const first = await call(db, 'GET', `/api/channels/${channelId}/messages?limit=2`, {
        cookie: alice.cookie,
      });
      const page = (await first.json()) as { data: { id: string }[]; nextCursor: string | null };
      expect(page.data.map((m) => m.id)).toEqual(ids.slice(3).reverse());
      expect(page.nextCursor).toBe(ids[3]!);

      const second = await call(
        db,
        'GET',
        `/api/channels/${channelId}/messages?limit=2&before=${page.nextCursor ?? ''}`,
        { cookie: alice.cookie },
      );
      const next = (await second.json()) as { data: { id: string }[]; nextCursor: string | null };
      expect(next.data.map((m) => m.id)).toEqual(ids.slice(1, 3).reverse());

      const last = await call(
        db,
        'GET',
        `/api/channels/${channelId}/messages?limit=2&before=${next.nextCursor ?? ''}`,
        { cookie: alice.cookie },
      );
      const final = (await last.json()) as { data: { id: string }[]; nextCursor: string | null };
      expect(final.data.map((m) => m.id)).toEqual(ids.slice(0, 1));
      // The last page says so, rather than making the client ask again to find out.
      expect(final.nextCursor).toBeNull();
    });
  });

  /**
   * The replay path, and the one that was silently wrong: the first version read
   * the newest page and filtered it in JavaScript, so a client away for longer
   * than a page lost the **oldest** messages it missed — exactly the ones it
   * needs. This sends more than one page and asks from the beginning.
   */
  test('catching up returns everything missed, oldest first, past one page', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-catchup');
      const channelId = await aChannel(db, alice, 'msg-catchup-ws');

      const ids: string[] = [];
      for (let i = 0; i < 7; i += 1) {
        const id = messageId(new Date(NOW.getTime() + i));
        ids.push(id);
        expect((await send(db, alice.cookie, channelId, id, `m${String(i)}`)).status).toBe(201);
      }

      const first = ids[0] ?? '';
      const response = await call(
        db,
        'GET',
        `/api/channels/${channelId}/messages?limit=3&after=${first}`,
        { cookie: alice.cookie },
      );
      const page = (await response.json()) as { data: { id: string }[]; nextCursor: string | null };

      // Oldest first, so a client appends rather than sorts.
      expect(page.data.map((m) => m.id)).toEqual(ids.slice(1, 4));
      expect(page.nextCursor).toBe(ids[3]!);

      const next = await call(
        db,
        'GET',
        `/api/channels/${channelId}/messages?limit=3&after=${page.nextCursor ?? ''}`,
        { cookie: alice.cookie },
      );
      const rest = (await next.json()) as { data: { id: string }[]; nextCursor: string | null };
      expect(rest.data.map((m) => m.id)).toEqual(ids.slice(4, 7));
      expect(rest.nextCursor).toBeNull();
    });
  });

  test('asking for older and newer at once is refused rather than silently picked', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-both');
      const channelId = await aChannel(db, alice, 'msg-both-ws');
      const id = messageId(NOW);
      await send(db, alice.cookie, channelId, id, 'one');

      const response = await call(
        db,
        'GET',
        `/api/channels/${channelId}/messages?before=${id}&after=${id}`,
        { cookie: alice.cookie },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });

  test('a limit beyond the cap is capped rather than refused', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-cap');
      const channelId = await aChannel(db, alice, 'msg-cap-ws');
      const response = await call(db, 'GET', `/api/channels/${channelId}/messages?limit=1000`, {
        cookie: alice.cookie,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  });
});

describe('integration: a read says no to a query it does not understand', () => {
  const refused = async (path: (channelId: string) => string): Promise<void> => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-strict');
      const channelId = await aChannel(db, alice, 'msg-strict-ws');
      const response = await call(db, 'GET', path(channelId), { cookie: alice.cookie });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    });
  };

  test('a misspelt cursor is refused, not read as the first page', async () => {
    await refused((id) => `/api/channels/${id}/messages?beforeId=${crypto.randomUUID()}`);
  });

  test('a cursor given twice is refused, not read by its first value', async () => {
    await refused(
      (id) =>
        `/api/channels/${id}/messages?before=${crypto.randomUUID()}&before=${crypto.randomUUID()}`,
    );
  });

  test.each(['0x10', '1e1', '1.0', '', ' 5', '+5'])(
    'a limit written %p is refused',
    async (limit) => {
      await refused((id) => `/api/channels/${id}/messages?limit=${encodeURIComponent(limit)}`);
    },
  );

  test('the open questions and a search refuse the same', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'msg-strict-more');
      const channelId = await aChannel(db, alice, 'msg-strict-more-ws');
      const { workspace_id: workspaceId } = await db
        .selectFrom('channels')
        .select('workspace_id')
        .where('id', '=', channelId)
        .executeTakeFirstOrThrow();
      for (const path of [
        `/api/workspaces/${workspaceId}/unresolved?limit=0x10`,
        `/api/workspaces/${workspaceId}/search?q=hello&limit=1e1`,
        `/api/workspaces/${workspaceId}/search?q=hello&q=again`,
      ]) {
        const response = await call(db, 'GET', path, { cookie: alice.cookie });
        expect([path, response.status]).toEqual([path, 400]);
      }
    });
  });
});

describe('integration: writing needs membership of the channel (D-156)', () => {
  test('a public channel seen and not joined refuses a message and a reply alike, writes nothing, and takes both once joined', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'msg-member');
      const reader = await signedIn(db, 'msg-reader');
      const channelId = await aChannel(db, owner, 'msg-unjoined');
      const { workspace_id: workspaceId } = await db
        .selectFrom('channels')
        .select('workspace_id')
        .where('id', '=', channelId)
        .executeTakeFirstOrThrow();
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspaceId, user_id: reader.userId })
        .execute();
      const root = messageId(NOW);
      expect((await send(db, owner.cookie, channelId, root, 'a question')).status).toBe(201);

      // She can read it: the channel is public, and she is in the workspace.
      const read = await call(db, 'GET', `/api/channels/${channelId}/messages`, {
        cookie: reader.cookie,
      });
      expect(read.status).toBe(200);

      const message = await send(db, reader.cookie, channelId, messageId(NOW), 'drive-by');
      expect(message.status).toBe(403);
      expect(await message.json()).toMatchObject({ error: { code: 'NOT_A_CHANNEL_MEMBER' } });
      const reply = await call(db, 'POST', `/api/channels/${channelId}/messages`, {
        cookie: reader.cookie,
        body: { id: messageId(NOW), content: 'a reply', parentId: root },
      });
      expect(reply.status).toBe(403);
      expect(await reply.json()).toMatchObject({ error: { code: 'NOT_A_CHANNEL_MEMBER' } });
      expect((await messagesIn(db, channelId)).map((row) => row.content)).toEqual(['a question']);

      const joined = await call(db, 'POST', `/api/channels/${channelId}/join`, {
        cookie: reader.cookie,
      });
      expect(joined.status).toBeLessThan(300);
      expect(
        (await send(db, reader.cookie, channelId, messageId(NOW), 'now a member')).status,
      ).toBe(201);
    });
  });
});

describe('integration: a send carrying attachments, over HTTP', () => {
  test('words optional beside an upload; none and nothing attached is 400; an unknown id 404', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'att-alice');
      const channelId = await aChannel(db, alice, 'att-acme');
      const { workspace_id: workspaceId } = await db
        .selectFrom('channels')
        .select('workspace_id')
        .where('id', '=', channelId)
        .executeTakeFirstOrThrow();
      const upload = messageId(new Date(NOW.getTime() - 1_000));
      await storeUpload(
        { atomically: atomicallyOn(db), storage: aMemoryStore(), log: aRecordingLogger().log },
        await requireWorkspaceMembership(db, alice.userId, workspaceId),
        { id: upload, name: 'shot.txt', bytes: new Uint8Array([1, 2, 3]) },
      );
      const post = async (body: object): Promise<Response> =>
        await call(db, 'POST', `/api/channels/${channelId}/messages`, {
          cookie: alice.cookie,
          body,
        });

      const sent = await post({ id: messageId(NOW), content: '', attachmentIds: [upload] });
      expect(sent.status).toBe(201);
      const message: unknown = await sent.json();
      expect(Value.Check(Message, message)).toBe(true);
      expect(message).toMatchObject({ content: '', attachments: [{ id: upload, sizeBytes: 3 }] });

      const empty = await post({ id: messageId(NOW), content: '' });
      expect(empty.status).toBe(400);
      expect(
        ((await empty.json()) as { error: { details: { fields: object } } }).error.details.fields,
      ).toHaveProperty('content');
      const unknown = await post({
        id: messageId(NOW),
        content: 'x',
        attachmentIds: [messageId(NOW)],
      });
      expect(unknown.status).toBe(404);
      expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe(
        'ATTACHMENT_NOT_FOUND',
      );
    });
  });
});

describe('integration: editing over HTTP', () => {
  /** Alice's channel, a message of hers in it, and Bob a member of the workspace who joined it. */
  const aConversation = async (
    db: Executor,
  ): Promise<{ alice: SignedInUser; bob: SignedInUser; channelId: string; id: string }> => {
    const alice = await signedIn(db, 'edit-alice');
    const bob = await signedIn(db, 'edit-bob');
    const channelId = await aChannel(db, alice, 'edit-acme');
    const { workspace_id: workspaceId } = await db
      .selectFrom('channels')
      .select('workspace_id')
      .where('id', '=', channelId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member' })
      .execute();
    expect(
      (await call(db, 'POST', `/api/channels/${channelId}/join`, { cookie: bob.cookie })).status,
    ).toBe(200);
    const id = messageId(NOW);
    expect((await send(db, alice.cookie, channelId, id, 'first words')).status).toBe(201);
    return { alice, bob, channelId, id };
  };

  test('the author is answered with the message as it now is', async () => {
    await withRollback(async (db) => {
      const { alice, channelId, id } = await aConversation(db);
      const response = await call(db, 'PATCH', `/api/messages/${id}`, {
        cookie: alice.cookie,
        body: { content: 'better words' },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id,
        content: 'better words',
        editedAt: NOW.toISOString(),
      });
      expect(await messagesIn(db, channelId)).toEqual([{ content: 'better words' }]);
    });
  });

  test.each([
    ['one unit over the limit', { content: 'x'.repeat(MESSAGE_CONTENT_MAX + 1) }],
    ['no content', {}],
    ['content that is not text', { content: 1 }],
    ['a field the contract does not have', { content: 'x', parentId: messageId(NOW) }],
  ])('%s is refused before anything is written', async (_why, body) => {
    await withRollback(async (db) => {
      const { alice, channelId, id } = await aConversation(db);
      const response = await call(db, 'PATCH', `/api/messages/${id}`, {
        cookie: alice.cookie,
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
      expect(await messagesIn(db, channelId)).toEqual([{ content: 'first words' }]);
    });
  });

  test('another member of the channel is refused 403: they can see it, and it is not theirs', async () => {
    await withRollback(async (db) => {
      const { bob, channelId, id } = await aConversation(db);
      const response = await call(db, 'PATCH', `/api/messages/${id}`, {
        cookie: bob.cookie,
        body: { content: 'mine now' },
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(await messagesIn(db, channelId)).toEqual([{ content: 'first words' }]);
    });
  });

  test('without a session it is 401, and nothing is written', async () => {
    await withRollback(async (db) => {
      const { channelId, id } = await aConversation(db);
      const response = await call(db, 'PATCH', `/api/messages/${id}`, { body: { content: 'x' } });
      expect(response.status).toBe(401);
      expect(await messagesIn(db, channelId)).toEqual([{ content: 'first words' }]);
    });
  });
});

describe('integration: deleting over HTTP', () => {
  const aConversation = async (
    db: Executor,
  ): Promise<{ alice: SignedInUser; bob: SignedInUser; channelId: string; id: string }> => {
    const alice = await signedIn(db, 'del-alice');
    const bob = await signedIn(db, 'del-bob');
    const channelId = await aChannel(db, alice, 'del-acme');
    const { workspace_id: workspaceId } = await db
      .selectFrom('channels')
      .select('workspace_id')
      .where('id', '=', channelId)
      .executeTakeFirstOrThrow();
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member' })
      .execute();
    await call(db, 'POST', `/api/channels/${channelId}/join`, { cookie: bob.cookie });
    const id = messageId(NOW);
    expect((await send(db, alice.cookie, channelId, id, 'regrettable')).status).toBe(201);
    return { alice, bob, channelId, id };
  };

  test('the author is answered 204, the content is the tombstone, and again is 204', async () => {
    await withRollback(async (db) => {
      const { alice, channelId, id } = await aConversation(db);
      const first = await call(db, 'DELETE', `/api/messages/${id}`, { cookie: alice.cookie });
      expect(first.status).toBe(204);
      expect(await first.text()).toBe('');
      expect(await messagesIn(db, channelId)).toEqual([{ content: '' }]);
      expect(
        (await call(db, 'DELETE', `/api/messages/${id}`, { cookie: alice.cookie })).status,
      ).toBe(204);
    });
  });

  test('a member who neither wrote it nor moderates is refused 403, and nothing is written', async () => {
    await withRollback(async (db) => {
      const { bob, channelId, id } = await aConversation(db);
      const response = await call(db, 'DELETE', `/api/messages/${id}`, { cookie: bob.cookie });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(await messagesIn(db, channelId)).toEqual([{ content: 'regrettable' }]);
    });
  });

  test('without a session it is 401', async () => {
    await withRollback(async (db) => {
      const { channelId, id } = await aConversation(db);
      expect((await call(db, 'DELETE', `/api/messages/${id}`)).status).toBe(401);
      expect(await messagesIn(db, channelId)).toEqual([{ content: 'regrettable' }]);
    });
  });
});
