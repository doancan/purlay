/** A hidden earlier root is a safe container for genuinely readable replies, never a content grant. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { messageId } from '@purlay/types';
import { aRoom } from '../../testing/rooms';
import { linkFile } from '../../testing/sent-files';
import { fixedClock } from '../../platform/clock';
import { attempt } from '../../testing/attempt';
import { messageHistory, messageWindow, sendMessage } from '../../features/chat/messages/messages';
import {
  requireAttachmentById,
  requireChannelById,
  requireMessageById,
  requireThreadContextById,
} from '../../features/chat/channels/guard';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';
import { aSession } from '../../testing/signed-in';
import { SESSION_COOKIE } from '../../platform/cookies';
import { followedThreads } from '../../features/chat/messages/followed';
import { threadReplies } from '../../features/chat/messages/threads';
import { catchUpIn } from '../../features/chat/channels/catch-up';

afterAll(closeIntegrationDatabase);

const setup = async (
  db: Transaction,
): Promise<{
  readonly channelId: string;
  readonly workspaceId: string;
  readonly ownerId: string;
  readonly guestId: string;
  readonly formerId: string;
  readonly oldId: string;
  readonly oldReplyId: string;
  readonly freshReplyId: string;
  readonly newId: string;
  readonly fileId: string;
  readonly oldAt: string;
  readonly freshAt: string;
}> => {
  const room = await aRoom(db, ['owner', 'guest', 'former']);
  const owner = room.members['owner'];
  const guest = room.members['guest'];
  const former = room.members['former'];
  if (owner === undefined || guest === undefined || former === undefined)
    throw new Error('Missing thread fixture');
  const now = Date.now();
  const old = new Date(now - 120_000);
  const fresh = new Date(now - 10_000);
  const oldId = messageId(old);
  const oldReplyId = messageId(new Date(now - 90_000));
  const freshReplyId = messageId(fresh);
  const newId = messageId(new Date(now - 5_000));
  await sendMessage(db, fixedClock(old), former.context, {
    id: oldId,
    content: 'ROOT_PRIVATE_BEFORE_ADMISSION',
  });
  await sendMessage(db, fixedClock(new Date(now - 90_000)), former.context, {
    id: oldReplyId,
    parentId: oldId,
    content: 'REPLY_PRIVATE_BEFORE_ADMISSION',
  });
  await db
    .updateTable('messages')
    .set({
      resolved_at: new Date(now - 80_000),
      resolved_by: former.userId,
      knowledge_version: 1,
      is_question: true,
      decision_note: 'OLD_PRIVATE_DECISION',
      accepted_answer_id: oldReplyId,
    })
    .where('id', '=', oldId)
    .execute();
  await sendMessage(db, fixedClock(fresh), owner.context, {
    id: freshReplyId,
    parentId: oldId,
    content: 'A readable new answer',
  });
  await sendMessage(db, fixedClock(new Date(now - 5_000)), owner.context, {
    id: newId,
    content: 'A new conversation',
  });
  const fileId = messageId(old);
  await db
    .insertInto('attachments')
    .values({
      id: fileId,
      workspace_id: room.workspaceId,
      uploader_id: former.userId,
      storage_key: `w/${room.workspaceId}/${fileId}`,
      file_name: 'PRIVATE_OLD_FILE.pdf',
      mime_type: 'application/pdf',
      size_bytes: '1',
      claimed_at: old,
    })
    .execute();
  await linkFile(db, {
    id: fileId,
    workspaceId: room.workspaceId,
    messageId: oldId,
    channelId: room.channelId,
  });
  await db
    .updateTable('workspace_members')
    .set({ access_kind: 'guest', guest_since: new Date(now - 60_000), guest_modules: ['chat'] })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', guest.userId)
    .execute();
  await db
    .deleteFrom('workspace_members')
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', former.userId)
    .execute();
  return {
    channelId: room.channelId,
    workspaceId: room.workspaceId,
    ownerId: owner.userId,
    guestId: guest.userId,
    formerId: former.userId,
    oldId,
    oldReplyId,
    freshReplyId,
    newId,
    fileId,
    oldAt: old.toISOString(),
    freshAt: fresh.toISOString(),
  };
};

describe('integration: restricted guest thread containers', () => {
  test('a guest pages through a safe old-root container and only its new activity is described', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const context = await requireChannelById(db, value.guestId, value.channelId);
      const first = await messageHistory(db, context, { limit: 1 });
      expect(first.data.map((row) => row.id)).toEqual([value.newId]);
      expect(first.nextCursor).toBe(value.newId);
      const second = await messageHistory(db, context, {
        before: first.nextCursor ?? '',
        limit: 1,
      });
      expect(second.data).toHaveLength(1);
      expect(second.data[0]).toMatchObject({
        id: value.oldId,
        historyHidden: true,
        replyAllowed: true,
        content: '',
        sender: null,
        githubEvent: null,
        attachments: [],
        reactions: [],
        mentions: [],
        editedAt: null,
        deletedAt: null,
        createdAt: value.freshAt,
        thread: { replyCount: 1, lastReplyAt: value.freshAt, resolvedAt: null, resolvedBy: null },
      });
      expect(second.nextCursor).toBeNull();
      const serialized = JSON.stringify(second);
      for (const secret of [
        'ROOT_PRIVATE_BEFORE_ADMISSION',
        'REPLY_PRIVATE_BEFORE_ADMISSION',
        'PRIVATE_OLD_FILE.pdf',
        'OLD_PRIVATE_DECISION',
        value.oldReplyId,
        value.formerId,
        value.oldAt,
      ])
        expect(serialized.includes(secret)).toBe(false);
      expect(await attempt(db, () => requireMessageById(db, value.guestId, value.oldId))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await attempt(db, () => requireAttachmentById(db, value.guestId, value.fileId))).toBe(
        'ATTACHMENT_NOT_FOUND',
      );
      const full = await messageHistory(
        db,
        await requireChannelById(db, value.ownerId, value.channelId),
      );
      expect(full.data.find((row) => row.id === value.oldId)?.content).toBe(
        'ROOT_PRIVATE_BEFORE_ADMISSION',
      );
    });
  });

  test('a link to a fresh reply opens a usable window without revealing the old root', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const visible = await requireMessageById(db, value.guestId, value.freshReplyId);
      const result = await messageWindow(db, visible);
      expect(result.target.id).toBe(value.freshReplyId);
      expect(result.data.find((row) => row.id === value.oldId)).toMatchObject({
        historyHidden: true,
        content: '',
        sender: null,
      });
      expect(JSON.stringify(result).includes('ROOT_PRIVATE_BEFORE_ADMISSION')).toBe(false);
      expect(JSON.stringify(result).includes(value.formerId)).toBe(false);
    });
  });

  test('a guest can answer the readable continuation but a guessed earlier root with no continuation stays unavailable', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const context = await requireChannelById(db, value.guestId, value.channelId);
      const result = await sendMessage(db, fixedClock(new Date()), context, {
        id: messageId(new Date()),
        parentId: value.oldId,
        content: 'The guest can continue this discussion',
      });
      expect(result.message.parentId).toBe(value.oldId);
      const unseen = messageId(new Date(Date.now() - 150_000));
      await db
        .insertInto('messages')
        .values({
          id: unseen,
          workspace_id: value.workspaceId,
          channel_id: value.channelId,
          sender_id: value.ownerId,
          content: 'No continuation',
          created_at: new Date(Date.now() - 150_000),
        })
        .execute();
      expect(
        await attempt(db, () =>
          sendMessage(db, fixedClock(new Date()), context, {
            id: messageId(new Date()),
            parentId: unseen,
            content: 'A guessed older message',
          }),
        ),
      ).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test.each(['expiry', 'future', 'leave', 'grant', 'module', 'channel'] as const)(
    'current %s policy denies a captured older-root continuation before body or pagination',
    async (policy) => {
      await withRollback(async (db) => {
        const value = await setup(db);
        const captured = await requireChannelById(db, value.guestId, value.channelId);
        if (policy === 'expiry')
          await db
            .updateTable('workspace_members')
            .set({ guest_expires_at: new Date(Date.now() - 1000) })
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .execute();
        else if (policy === 'future')
          await db
            .updateTable('workspace_members')
            .set({ guest_since: new Date(Date.now() + 60_000) })
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .execute();
        else if (policy === 'leave')
          await db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .execute();
        else if (policy === 'grant')
          await db
            .updateTable('channel_members')
            .set({ joined_at: new Date(Date.now() - 1000) })
            .where('channel_id', '=', value.channelId)
            .where('user_id', '=', value.guestId)
            .execute();
        else if (policy === 'module')
          await db
            .updateTable('workspace_members')
            .set({ guest_modules: ['issues'] })
            .where('workspace_id', '=', value.workspaceId)
            .where('user_id', '=', value.guestId)
            .execute();
        else
          await db
            .updateTable('channels')
            .set({ deleted_at: new Date() })
            .where('id', '=', value.channelId)
            .execute();
        expect(
          await attempt(db, () =>
            requireThreadContextById(db, value.guestId, value.oldId, { deleted: 'include' }),
          ),
        ).toBe('MESSAGE_NOT_FOUND');
        const empty = await messageHistory(db, captured, { limit: 1 });
        expect(empty.data).toHaveLength(0);
        expect(empty.nextCursor).toBeNull();
      });
    },
  );

  test('a missing readable continuation and an older reply never become context capabilities', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      await db.deleteFrom('messages').where('id', '=', value.freshReplyId).execute();
      expect(
        await attempt(db, () =>
          requireThreadContextById(db, value.guestId, value.oldId, { deleted: 'include' }),
        ),
      ).toBe('MESSAGE_NOT_FOUND');
      expect(
        await attempt(db, () =>
          requireThreadContextById(db, value.guestId, value.oldReplyId, { deleted: 'include' }),
        ),
      ).toBe('MESSAGE_NOT_FOUND');
      const page = await messageHistory(
        db,
        await requireChannelById(db, value.guestId, value.channelId),
      );
      expect(page.data.map((row) => row.id)).toEqual([value.newId]);
    });
  });

  test('a deleted earlier root retains its readable replies without allowing another send', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      await db
        .updateTable('messages')
        .set({ deleted_at: new Date() })
        .where('id', '=', value.oldId)
        .execute();
      const context = await requireThreadContextById(db, value.guestId, value.oldId, {
        deleted: 'include',
      });
      expect((await threadReplies(db, context)).data.map((row) => row.id)).toEqual([
        value.freshReplyId,
      ]);
      const page = await messageHistory(db, context.context);
      expect(page.data.find((row) => row.id === value.oldId)).toMatchObject({
        historyHidden: true,
        replyAllowed: false,
        content: '',
        sender: null,
      });
      expect(
        await attempt(db, () =>
          sendMessage(db, fixedClock(new Date()), context.context, {
            id: messageId(new Date()),
            parentId: value.oldId,
            content: 'No longer replyable',
          }),
        ),
      ).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('actual HTTP thread traversal, following, receipts and sending do not grant the older message or file', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const clock = fixedClock(new Date());
      const session = await aSession(db, clock, value.guestId);
      const app = createApp(testDependencies({ database: db, clock }));
      const call = async (method: string, path: string, body?: unknown): Promise<Response> =>
        await app.handle(
          new Request('https://purlay.test' + path, {
            method,
            headers: {
              cookie: `${SESSION_COOKIE}=${session.token}`,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const thread = await call('GET', `/api/messages/${value.oldId}/thread`);
      expect(thread.status).toBe(200);
      const page: unknown = await thread.json();
      expect(JSON.stringify(page).includes('A readable new answer')).toBe(true);
      expect(JSON.stringify(page).includes('PRIVATE_BEFORE_ADMISSION')).toBe(false);
      const around = await call('GET', `/api/messages/${value.freshReplyId}/around`);
      expect(around.status).toBe(200);
      const window: unknown = await around.json();
      expect(JSON.stringify(window).includes('"historyHidden":true')).toBe(true);
      expect(JSON.stringify(window).includes(value.formerId)).toBe(false);
      expect((await call('GET', `/api/messages/${value.oldId}`)).status).toBe(404);
      expect((await call('GET', `/api/attachments/${value.fileId}`)).status).toBe(404);
      expect((await call('POST', `/api/messages/${value.oldId}/resolve`)).status).toBe(404);
      const follow = await call('PUT', `/api/messages/${value.oldId}/follow`, { following: true });
      expect(follow.status).toBe(200);
      expect((await call('GET', `/api/messages/${value.oldId}/follow`)).status).toBe(200);
      const followed = await followedThreads(
        db,
        await requireWorkspaceMembership(db, value.guestId, value.workspaceId),
      );
      expect(followed.data.find((row) => row.root.id === value.oldId)?.root).toMatchObject({
        historyHidden: true,
        content: '',
        sender: null,
      });
      expect(JSON.stringify(followed).includes('OLD_PRIVATE_DECISION')).toBe(false);
      expect(
        (
          await call('PUT', `/api/messages/${value.oldId}/thread/read`, {
            lastReadMessageId: value.freshReplyId,
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await call('PUT', `/api/messages/${value.oldId}/thread/read`, {
            lastReadMessageId: value.oldReplyId,
          })
        ).status,
      ).toBe(404);
      const id = messageId(new Date());
      const sent = await call('POST', `/api/channels/${value.channelId}/messages`, {
        id,
        parentId: value.oldId,
        content: 'A real guest HTTP reply',
      });
      expect(sent.ok).toBe(true);
      const echo: unknown = await sent.json();
      expect(JSON.stringify(echo).includes('A real guest HTTP reply')).toBe(true);
      expect(JSON.stringify(echo).includes('OLD_PRIVATE_DECISION')).toBe(false);
      expect(JSON.stringify(echo).includes(value.formerId)).toBe(false);
    });
  });

  test('catch-up keeps a new unread reply useful without quoting the earlier root', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const result = await catchUpIn(
        db,
        await requireChannelById(db, value.guestId, value.channelId),
      );
      expect(result.threads.find((row) => row.root.id === value.oldId)).toMatchObject({
        root: { historyHidden: true, content: '', sender: null, createdAt: value.freshAt },
        unreadCount: 1,
        firstUnreadMessageId: value.freshReplyId,
      });
      expect(JSON.stringify(result).includes(value.formerId)).toBe(false);
      expect(JSON.stringify(result).includes('OLD_PRIVATE_DECISION')).toBe(false);
    });
  });

  test('a formerly full context cannot use a later guest admission to recover earlier content', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'member',
          guest_since: null,
          guest_expires_at: null,
          guest_modules: null,
        })
        .where('workspace_id', '=', value.workspaceId)
        .where('user_id', '=', value.guestId)
        .execute();
      const captured = await requireChannelById(db, value.guestId, value.channelId);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: new Date(Date.now() - 60_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', value.workspaceId)
        .where('user_id', '=', value.guestId)
        .execute();
      const page = await messageHistory(db, captured);
      expect(page.data.find((row) => row.id === value.oldId)).toMatchObject({
        historyHidden: true,
        content: '',
        sender: null,
      });
      expect(JSON.stringify(page).includes('ROOT_PRIVATE_BEFORE_ADMISSION')).toBe(false);
    });
  });

  test('a thread context remains404 across workspaces and private channels even when its root has new replies', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const elsewhere = await aRoom(db, ['foreign']);
      const writer = elsewhere.members['foreign'];
      if (writer === undefined) throw new Error('Missing foreign writer');
      const root = await sendMessage(db, fixedClock(new Date()), writer.context, {
        id: messageId(new Date()),
        content: 'Foreign context',
      });
      await sendMessage(db, fixedClock(new Date()), writer.context, {
        id: messageId(new Date()),
        parentId: root.message.id,
        content: 'Foreign reply',
      });
      expect(
        await attempt(db, () => requireThreadContextById(db, value.guestId, root.message.id)),
      ).toBe('MESSAGE_NOT_FOUND');
      const hidden = await db
        .insertInto('channels')
        .values({
          workspace_id: value.workspaceId,
          name: 'unshared-private-thread',
          type: 'private',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const parent = messageId(new Date());
      await db
        .insertInto('messages')
        .values({
          id: parent,
          workspace_id: value.workspaceId,
          channel_id: hidden.id,
          sender_id: value.ownerId,
          content: 'Private context',
        })
        .execute();
      await db
        .insertInto('messages')
        .values({
          id: messageId(new Date()),
          parent_id: parent,
          workspace_id: value.workspaceId,
          channel_id: hidden.id,
          sender_id: value.ownerId,
          content: 'Private reply',
        })
        .execute();
      expect(await attempt(db, () => requireThreadContextById(db, value.guestId, parent))).toBe(
        'MESSAGE_NOT_FOUND',
      );
    });
  });

  test('projecting many earlier roots batches their safe metadata and never looks up their old sidecars', async () => {
    await withRollback(async (db) => {
      const value = await setup(db);
      const context = await requireChannelById(db, value.guestId, value.channelId);
      const read = async (): Promise<{
        queries: number;
        page: Awaited<ReturnType<typeof messageHistory>>;
      }> => {
        let queries = 0;
        let oldSidecar = false;
        const counted = db.withPlugin({
          transformQuery: (args): typeof args.node => {
            const text = JSON.stringify(args.node);
            if (
              text.includes(value.oldId) &&
              (text.includes('message_attachments') || text.includes('decision_note'))
            )
              oldSidecar = true;
            return args.node;
          },
          transformResult: (args): Promise<typeof args.result> => {
            queries += 1;
            return Promise.resolve(args.result);
          },
        });
        const page = await messageHistory(counted, context, { limit: 50 });
        expect(oldSidecar).toBe(false);
        return { queries, page };
      };
      const small = await read();
      const now = Date.now();
      const roots = Array.from({ length: 20 }, () => ({
        id: messageId(new Date(now - 120_000)),
        workspace_id: value.workspaceId,
        channel_id: value.channelId,
        sender_id: value.ownerId,
        content: 'BATCH_PRIVATE_OLD_ROOT',
        created_at: new Date(now - 120_000),
      }));
      await db.insertInto('messages').values(roots).execute();
      await db
        .insertInto('messages')
        .values(
          roots.map((root) => ({
            id: messageId(new Date()),
            parent_id: root.id,
            workspace_id: value.workspaceId,
            channel_id: value.channelId,
            sender_id: value.ownerId,
            content: 'A readable batched reply',
          })),
        )
        .execute();
      const large = await read();
      expect(large.queries).toBe(small.queries);
      expect(large.page.data).toHaveLength(22);
      expect(large.page.data.filter((row) => row.historyHidden === true)).toHaveLength(21);
      expect(JSON.stringify(large.page).includes('BATCH_PRIVATE_OLD_ROOT')).toBe(false);
    });
  });
});
