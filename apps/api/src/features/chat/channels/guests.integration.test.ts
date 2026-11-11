/** Guest authority is tested through real membership, channel, message and download guards. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { aRoom, type Room } from '../../../testing/rooms';
import { linkFile } from '../../../testing/sent-files';
import { requireOwnUpload } from '../../../modules/attachments/readable';
import { entitledTo, requireWorkspaceMembership } from '../../../platform/tenancy';
import { AppError } from '../../../platform/errors';
import { messageHistory, messageWindow, missedIn, sendMessage } from '../messages/messages';
import { searchIn } from '../search/search';
import { channelPins } from '../pins/pins';
import { savedIds, savedPage } from '../saved/saved';
import { unresolvedIn } from '../messages/threads';
import { followedThreads } from '../messages/followed';
import { changesIn } from '../messages/changes';
import { reminderList } from '../reminders/reminders';
import { catchUpIn } from './catch-up';
import { channelFiles } from './files';
import { createChannel } from './channels';
import { openConversation } from './direct-messages';
import { addMember } from './members';
import { updateChannel } from './settings';
import { fixedClock } from '../../../platform/clock';
import { attempt } from '../../../testing/attempt';
import { inboxOf } from '../notifications/notifications';
import { markRead, markUnread } from './read-state';
import { memberReadScope, saveReadScope } from './read-scope';
import { unreadMessage, unreadMessages } from './unread';
import { membershipsOf } from '../../../modules/workspaces/workspaces';
import { convertGuest } from '../../../modules/workspaces/guest-conversion';
import { changeRole, removeMember } from '../../../modules/workspaces/members';
import { chatWorkspaceChannels } from './workspace-channels';
import { liveChannelScope } from './live-history';
import { readBuilt } from '../messages/reader';
import {
  requireAttachmentById,
  requireChannelById,
  requireMessageById,
  visibleChannelIds,
} from './guard';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const restrict = async (
  db: Executor,
  room: Room,
  expiresAt: Date | null = null,
): Promise<{ readonly userId: string; readonly since: Date }> => {
  const userId = room.members['guest']?.userId;
  if (userId === undefined) throw new Error('Missing guest fixture');
  const since = new Date(Date.now() - 60_000);
  await db
    .updateTable('workspace_members')
    .set({
      access_kind: 'guest',
      guest_since: since,
      guest_expires_at: expiresAt,
      guest_modules: ['chat'],
    })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', userId)
    .execute();
  return { userId, since };
};

const anotherChannel = async (db: Executor, room: Room): Promise<string> =>
  (
    await db
      .insertInto('channels')
      .values({ workspace_id: room.workspaceId, name: 'not-shared', type: 'public' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

const upload = async (db: Executor, room: Room, uploaderId: string): Promise<string> => {
  const id = messageId(new Date());
  await db
    .insertInto('attachments')
    .values({
      id,
      workspace_id: room.workspaceId,
      uploader_id: uploaderId,
      storage_key: `w/${room.workspaceId}/${id}`,
      file_name: 'supplier.pdf',
      mime_type: 'application/pdf',
      size_bytes: '1',
    })
    .execute();
  return id;
};

const refusal = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    expect(error.status).toBe(404);
    return error.body.code;
  }
  throw new Error('Restricted resource was not refused');
};

/** Stored saves and pins must obey a later grant, including when the unread scope is widened. */
const historyFixture = async (
  db: Executor,
): Promise<{
  readonly room: Room;
  readonly userId: string;
  readonly oldId: string;
  readonly newId: string;
}> => {
  const room = await aRoom(db, ['owner', 'guest']);
  const { userId, since } = await restrict(db, room);
  await db
    .updateTable('channel_members')
    .set({ joined_at: new Date(since.getTime() + 1_000) })
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', userId)
    .execute();
  const ids: string[] = [];
  for (const delta of [500, 2_000]) {
    const created = new Date(since.getTime() + delta);
    const id = messageId(created);
    ids.push(id);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        sender_id: room.members['owner']?.userId ?? '',
        content: 'shared supplier question',
        created_at: created,
        is_question: true,
      })
      .execute();
    await db
      .insertInto('pinned_messages')
      .values({
        message_id: id,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        pinned_by: room.members['owner']?.userId ?? '',
        pinned_at: created,
      })
      .execute();
    await db
      .insertInto('saved_messages')
      .values({
        id: messageId(created),
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        user_id: userId,
        message_id: id,
        state: 'in_progress',
        saved_at: created,
        updated_at: created,
      })
      .execute();
  }
  return { room, userId, oldId: ids[0] ?? '', newId: ids[1] ?? '' };
};

describe('integration: restricted workspace guests', () => {
  test('an administrator can remove an expired guest and revoke every assigned channel', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId } = await restrict(db, room, new Date(Date.now() - 1_000));
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const removed = await removeMember(
        db,
        fixedClock(new Date()),
        owner,
        userId,
        chatWorkspaceChannels,
      );
      expect(removed.channelIds).toEqual([room.channelId]);
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', userId)
          .execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('channel_members')
          .select('channel_id')
          .where('channel_id', '=', room.channelId)
          .where('user_id', '=', userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('one current audience read serves a publication with different guest history floors', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest', 'later']);
      const { userId, since } = await restrict(db, room);
      const laterId = room.members['later']?.userId ?? '';
      await db
        .updateTable('channel_members')
        .set({ joined_at: since })
        .where('channel_id', '=', room.channelId)
        .where('user_id', 'in', [userId, laterId])
        .execute();
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: new Date(since.getTime() + 3_000),
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', laterId)
        .execute();
      const id = messageId(new Date(since.getTime() + 2_000));
      await db
        .insertInto('messages')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: room.members['owner']?.userId ?? '',
          content: 'A shared revision',
          created_at: new Date(since.getTime() + 2_000),
        })
        .execute();
      const first = await requireChannelById(db, userId, room.channelId);
      const later = await requireChannelById(db, laterId, room.channelId);
      const message = await readBuilt(db, id);
      if (message === undefined) throw new Error('Missing live message fixture');
      let statements = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: (args) => {
          statements += 1;
          return Promise.resolve(args.result);
        },
      });
      const scopes = liveChannelScope();
      const a = scopes(counted, first);
      const b = scopes(counted, later);
      const frame = {
        event: 'MESSAGE_REVISED' as const,
        data: {
          channelId: room.channelId,
          messageId: id,
          parentId: null,
          content: 'Changed',
          editedAt: null,
          deletedAt: null,
          mentions: [],
        },
        ts: Date.now(),
        version: 1,
      };
      const signal = new AbortController().signal;
      expect(
        await Promise.all([
          a.accepts(frame, signal),
          a.accepts(frame, signal),
          b.accepts(frame, signal),
        ]),
      ).toEqual([true, true, false]);
      expect(statements).toBe(1);
      const oldId = messageId(new Date(since.getTime() - 1_000));
      await db
        .insertInto('messages')
        .values({
          id: oldId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: room.members['owner']?.userId ?? '',
          content: 'Before admission',
          created_at: new Date(since.getTime() - 1_000),
        })
        .execute();
      expect(
        await a.accepts(
          {
            event: 'MESSAGE_CREATED',
            data: {
              ...message,
              id: oldId,
              createdAt: new Date().toISOString(),
            },
            ts: Date.now(),
          },
          signal,
        ),
      ).toBe(false);
      expect(statements).toBe(2);
    });
  });

  test('membership responses declare restricted access and expiry removes the workspace from the account', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId, since } = await restrict(db, room);
      const clock = fixedClock(new Date());
      const [membership] = await membershipsOf(db, clock, userId);
      expect(membership?.access).toEqual({
        kind: 'guest',
        historySince: since.toISOString(),
        expiresAt: null,
      });
      expect(membership?.modules).toEqual(['chat']);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(Date.now() - 1_000) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await membershipsOf(db, clock, userId)).toEqual([]);
    });
  });

  test('a captured expiry checks current extension, conversion and module removal without retaining an earlier answer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const end = new Date(Date.now() + 60_000);
      const { userId, since } = await restrict(db, room, end);
      const context = await requireChannelById(db, userId, room.channelId);
      const expiry = liveChannelScope()(db, context).expiry;
      if (expiry === undefined) throw new Error('Missing current-membership expiry check');
      const signal = new AbortController().signal;
      expect(expiry.workspaceId).toBe(room.workspaceId);
      expect(await expiry.recheck(signal)).toBe(true);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(Date.now() - 1) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await expiry.recheck(signal)).toBe(false);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(end.getTime() + 60_000) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await expiry.recheck(signal)).toBe(true);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: null, guest_modules: ['issues'] })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await expiry.recheck(signal)).toBe(false);
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(since.getTime() + 1), guest_modules: ['chat'] })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      await convertGuest(
        db,
        fixedClock(new Date()),
        owner,
        userId,
        { confirmFullAccess: true },
        chatWorkspaceChannels,
      );
      expect(await expiry.recheck(signal)).toBe(true);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await expiry.recheck(signal)).toBe(false);
    });
  });

  test('expiry reads share current membership across history floors, but cannot substitute membership in another workspace', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const end = new Date(Date.now() + 60_000);
      const { userId, since } = await restrict(db, room, end);
      const first = await requireChannelById(db, userId, room.channelId);
      await db
        .updateTable('channel_members')
        .set({ joined_at: new Date(since.getTime() + 1000) })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', userId)
        .execute();
      const later = await requireChannelById(db, userId, room.channelId);
      let queries = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => {
          queries += 1;
          return args.node;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const scopes = liveChannelScope();
      const a = scopes(counted, first).expiry;
      const b = scopes(counted, later).expiry;
      if (a === undefined || b === undefined) throw new Error('Missing expiry scopes');
      const signal = new AbortController().signal;
      expect(await Promise.all([a.recheck(signal), b.recheck(signal)])).toEqual([true, true]);
      expect(queries).toBe(1);
      const other = await aRoom(db, ['owner']);
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: other.workspaceId,
          user_id: userId,
          role: 'member',
          access_kind: 'guest',
          guest_since: since,
          guest_expires_at: end,
          guest_modules: ['chat'],
        })
        .execute();
      await db
        .insertInto('channel_members')
        .values({ channel_id: other.channelId, user_id: userId, joined_at: since })
        .execute();
      const elsewhere = await requireChannelById(db, userId, other.channelId);
      const otherExpiry = scopes(counted, elsewhere).expiry;
      if (otherExpiry === undefined) throw new Error('Missing other workspace expiry');
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await Promise.all([a.recheck(signal), otherExpiry.recheck(signal)])).toEqual([
        false,
        true,
      ]);
      expect(queries).toBe(3);
    });
  });

  test('an unavailable expiry lookup is a failure, never a false membership denial', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId } = await restrict(db, room, new Date(Date.now() + 60_000));
      const context = await requireChannelById(db, userId, room.channelId);
      const failure = new Error('Membership read unavailable');
      const unavailable = db.withPlugin({
        transformQuery: () => {
          throw failure;
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const scopes = liveChannelScope();
      const allowed = scopes(db, context).expiry;
      const expiry = scopes(unavailable, context).expiry;
      if (expiry === undefined || allowed === undefined) throw new Error('Missing expiry lookup');
      const signal = new AbortController().signal;
      const simultaneous = await Promise.all([
        allowed.recheck(signal),
        expiry.recheck(signal).then(
          () => undefined,
          (error: unknown) => error,
        ),
      ]);
      expect(simultaneous).toEqual([true, failure]);
      for (let repeat = 0; repeat < 2; repeat += 1)
        expect(
          await expiry.recheck(new AbortController().signal).then(
            () => undefined,
            (error: unknown) => error,
          ),
        ).toBe(failure);
    });
  });

  test('two users at the same captured deadline cannot share the other person’s membership result', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest', 'later']);
      const end = new Date(Date.now() + 60_000);
      const { userId, since } = await restrict(db, room, end);
      const laterId = room.members['later']?.userId;
      if (laterId === undefined) throw new Error('Missing second guest');
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: since,
          guest_expires_at: end,
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', laterId)
        .execute();
      const first = await requireChannelById(db, userId, room.channelId);
      const later = await requireChannelById(db, laterId, room.channelId);
      const scopes = liveChannelScope();
      const a = scopes(db, first).expiry;
      const b = scopes(db, later).expiry;
      if (a === undefined || b === undefined) throw new Error('Missing two guest expiries');
      await db
        .updateTable('workspace_members')
        .set({ guest_expires_at: new Date(Date.now() - 1000) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      const signal = new AbortController().signal;
      expect(await Promise.all([a.recheck(signal), b.recheck(signal)])).toEqual([false, true]);
    });
  });

  test('a channel guest scope cannot authorize user/session frames for another audience', async () => {
    await withRollback(async (db) => {
      const { room, userId } = await historyFixture(db);
      const guest = await requireChannelById(db, userId, room.channelId);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      const other = await createChannel(db, fixedClock(new Date()), owner, { name: 'not-invited' });
      const scope = liveChannelScope()(db, guest);

      const ts = Date.now();
      const frames: readonly ServerFrame[] = [
        ...(
          [
            'CHANNELS_UPDATED',
            'INBOX_UPDATED',
            'NOTIFICATIONS_UPDATED',
            'REMINDERS_UPDATED',
            'SAVED_UPDATED',
            'WORKSPACE_UPDATED',
          ] as const
        ).map((event) => ({ event, data: { workspaceId: room.workspaceId }, ts })),
        { event: 'ACCESS_REVOKED', data: { channelIds: [room.channelId] }, ts },
        { event: 'ACK', data: { id: messageId(new Date()) }, ts },
        { event: 'CHANNEL_ADDED', data: other, ts },
        { event: 'DEEP_WORK_UPDATED', data: { workspaceId: room.workspaceId, until: null }, ts },
        { event: 'ERROR', data: { code: 'FORBIDDEN', message: 'Not this audience.' }, ts },
        { event: 'PONG', data: {}, ts },
        {
          event: 'PRESENCE',
          data: { changes: [{ userId: owner.userId, online: true, away: false, version: 1 }] },
          ts,
        },
        { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts },
      ];
      const signal = new AbortController().signal;
      for (const frame of frames)
        expect({ event: frame.event, accepted: await scope.accepts(frame, signal) }).toEqual({
          event: frame.event,
          accepted: false,
        });
      expect(
        await scope.accepts(
          {
            event: 'TYPING',
            data: { channelId: room.channelId, userId: owner.userId, ttlMs: 1000 },
            ts,
          },
          signal,
        ),
      ).toBe(true);
    });
  });

  test('a generic role patch cannot turn a guest into an administrator', async () => {
    await withRollback(async (db) => {
      const { room, userId } = await historyFixture(db);
      const owner = await requireWorkspaceMembership(
        db,
        room.members['owner']?.userId ?? '',
        room.workspaceId,
      );
      expect(
        await attempt(db, () => changeRole(db, fixedClock(new Date()), owner, userId, 'admin')),
      ).toBe('FORBIDDEN');
    });
  });

  test('a future admission grants nothing and an old root cannot be reopened by a new reply', async () => {
    await withRollback(async (db) => {
      const { room, userId, oldId } = await historyFixture(db);
      const channel = await requireChannelById(db, userId, room.channelId);
      expect(
        await attempt(db, () =>
          sendMessage(db, fixedClock(new Date()), channel, {
            id: messageId(new Date()),
            content: 'A guessed old thread',
            parentId: oldId,
          }),
        ),
      ).toBe('MESSAGE_NOT_FOUND');
      await db
        .updateTable('workspace_members')
        .set({ guest_since: new Date(Date.now() + 60_000) })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await refusal(() => requireWorkspaceMembership(db, userId, room.workspaceId))).toBe(
        'WORKSPACE_NOT_FOUND',
      );
      expect(await refusal(() => requireChannelById(db, userId, room.channelId))).toBe(
        'CHANNEL_NOT_FOUND',
      );
    });
  });

  test('read controls and reopened unread scopes never expose or count earlier messages', async () => {
    await withRollback(async (db) => {
      const { room, userId, oldId, newId } = await historyFixture(db);
      const channel = await requireChannelById(db, userId, room.channelId);
      const clock = fixedClock(new Date());
      expect(await attempt(db, () => markRead(db, clock, channel, oldId))).toBe(
        'MESSAGE_NOT_FOUND',
      );
      expect(await attempt(db, () => markUnread(db, channel, oldId))).toBe('MESSAGE_NOT_FOUND');
      await saveReadScope(db, room.channelId, userId, {
        unread_since: new Date(0),
        unread_history_from: oldId,
        thread_read_baseline_id: null,
      });
      const scope = memberReadScope('channel_members');
      const counted = await db
        .selectFrom('channel_members')
        .select([
          unreadMessages(scope, room.channelId).as('unread'),
          unreadMessage(scope, oldId).as('old_waiting'),
        ])
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', userId)
        .executeTakeFirstOrThrow();
      expect(counted).toEqual({ unread: 1, old_waiting: false });
      await markRead(db, clock, channel, newId);
      const reopened = await markUnread(db, channel, newId);
      expect(reopened.state).toMatchObject({ unreadCount: 1, lastReadMessageId: null });
    });
  });

  test('a guest cannot create or manage conversations or expand another person’s scope', async () => {
    await withRollback(async (db) => {
      const { room, userId } = await historyFixture(db);
      const workspace = await requireWorkspaceMembership(db, userId, room.workspaceId);
      const channel = await requireChannelById(db, userId, room.channelId);
      const clock = fixedClock(new Date());
      const owner = room.members['owner']?.userId ?? '';
      expect(
        await attempt(db, () => createChannel(db, clock, workspace, { name: 'guest-created' })),
      ).toBe('FORBIDDEN');
      expect(await attempt(db, () => openConversation(db, clock, workspace, [owner]))).toBe(
        'FORBIDDEN',
      );
      expect(await attempt(db, () => addMember(db, clock, channel, owner))).toBe('FORBIDDEN');
      expect(
        await attempt(db, () => updateChannel(db, clock, channel, { topic: 'changed by guest' })),
      ).toBe('FORBIDDEN');
    });
  });

  test('generic channel and direct-message invitations cannot expand a guest’s granted channels', async () => {
    await withRollback(async (db) => {
      const { room, userId } = await historyFixture(db);
      const other = await anotherChannel(db, room);
      const owner = room.members['owner']?.userId ?? '';
      await db
        .insertInto('channel_members')
        .values({ channel_id: other, user_id: owner })
        .execute();
      const workspace = await requireWorkspaceMembership(db, owner, room.workspaceId);
      const channel = await requireChannelById(db, owner, other);
      const clock = fixedClock(new Date());
      expect(await attempt(db, () => addMember(db, clock, channel, userId))).toBe('USER_NOT_FOUND');
      expect(await attempt(db, () => openConversation(db, clock, workspace, [userId]))).toBe(
        'USER_NOT_FOUND',
      );
      const guest = await requireWorkspaceMembership(db, userId, room.workspaceId);
      expect(await visibleChannelIds(db, guest)).toEqual([room.channelId]);
    });
  });

  test('history pages, windows and socket replays cannot return the earlier channel history', async () => {
    await withRollback(async (db) => {
      const { room, userId, oldId, newId } = await historyFixture(db);
      const context = await requireChannelById(db, userId, room.channelId);
      const history = await messageHistory(db, context, { limit: 1 });
      expect(history.data.map((m) => m.id)).toEqual([newId]);
      expect(history.nextCursor).toBeNull();
      expect((await messageHistory(db, context, { before: newId })).data).toEqual([]);
      expect((await messageHistory(db, context, { after: oldId })).data.map((m) => m.id)).toEqual([
        newId,
      ]);
      const window = await messageWindow(db, await requireMessageById(db, userId, newId));
      expect(window.data.map((m) => m.id)).toEqual([newId]);
      const replay = await missedIn(db, [{ context, after: messageId(new Date(0)) }], 10);
      expect(replay.get(room.channelId)?.data.map((m) => m.id)).toEqual([newId]);
      const owner = await requireChannelById(
        db,
        room.members['owner']?.userId ?? '',
        room.channelId,
      );
      expect((await messageHistory(db, owner)).data.map((m) => m.id)).toEqual([newId, oldId]);
    });
  });

  test('search and open questions apply the admission floor before pagination', async () => {
    await withRollback(async (db) => {
      const { room, userId, newId } = await historyFixture(db);
      const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
      const visible = await visibleChannelIds(db, context);
      for (const query of [
        { q: 'supplier', limit: 1 },
        { q: '', question: 'yes' as const },
      ]) {
        const page = await searchIn(db, context, visible, query);
        expect(page.data.map((m) => m.id)).toEqual([newId]);
        expect(page.nextCursor).toBeNull();
      }
      expect((await unresolvedIn(db, context, visible)).data.map((m) => m.id)).toEqual([newId]);
    });
  });

  test('pins and previously saved messages cannot reopen history before the current channel grant', async () => {
    await withRollback(async (db) => {
      const { room, userId, newId } = await historyFixture(db);
      const workspace = await requireWorkspaceMembership(db, userId, room.workspaceId);
      const channel = await requireChannelById(db, userId, room.channelId);
      expect((await channelPins(db, channel)).map((p) => p.message.id)).toEqual([newId]);
      expect((await savedIds(db, workspace)).map((s) => s.messageId)).toEqual([newId]);
      const saves = await savedPage(db, workspace, { state: 'in_progress', limit: 1 });
      expect(saves.data.map((s) => s.message.id)).toEqual([newId]);
      expect(saves.nextCursor).toBeNull();
    });
  });

  test('the inbox shows new replies without quoting or naming the author of their earlier root', async () => {
    await withRollback(async (db) => {
      const { room, userId, oldId } = await historyFixture(db);
      const replyId = messageId(new Date());
      await db
        .insertInto('messages')
        .values({
          id: replyId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: room.members['owner']?.userId ?? '',
          content: 'A reply after admission',
          parent_id: oldId,
        })
        .execute();
      for (const id of [oldId, replyId]) {
        await db
          .insertInto('notifications')
          .values({
            user_id: userId,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            message_id: id,
            type: id === oldId ? 'mention' : 'thread_reply',
          })
          .execute();
      }
      const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
      const page = await inboxOf(db, context, await visibleChannelIds(db, context), {
        workspaceId: room.workspaceId,
        limit: 1,
      });
      expect(page.data.map((n) => n.message.id)).toEqual([replyId]);
      expect(page.nextCursor).toBeNull();
      expect(page.data[0]?.thread).toEqual({ rootId: oldId, excerpt: null, authorId: null });
      const window = await messageWindow(db, await requireMessageById(db, userId, replyId));
      expect(window.target.id).toBe(replyId);
      expect(window.data.find((message) => message.id === oldId)).toMatchObject({
        historyHidden: true,
        sender: null,
        content: '',
        attachments: [],
        thread: { replyCount: 1, resolvedAt: null, resolvedBy: null },
      });
      expect(await refusal(() => requireMessageById(db, userId, oldId))).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('catch-up, offline changes, followed threads and reminders use the current history floor', async () => {
    await withRollback(async (db) => {
      const { room, userId, oldId, newId } = await historyFixture(db);
      for (const id of [oldId, newId]) {
        await db
          .insertInto('thread_follows')
          .values({
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            user_id: userId,
            message_id: id,
            following: true,
          })
          .execute();
        await db
          .insertInto('message_reminders')
          .values({
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            user_id: userId,
            message_id: id,
            remind_at: new Date(Date.now() + 60_000),
          })
          .execute();
      }
      const workspace = await requireWorkspaceMembership(db, userId, room.workspaceId);
      const channel = await requireChannelById(db, userId, room.channelId);
      expect(
        (await changesIn(db, channel, { since: new Date(0).toISOString() })).data.map((m) => m.id),
      ).toEqual([newId]);
      expect((await catchUpIn(db, channel)).roots.data.map((m) => m.id)).toEqual([newId]);
      expect((await followedThreads(db, workspace)).data.map((t) => t.root.id)).toEqual([newId]);
      expect((await reminderList(db, workspace)).map((r) => r.message.id)).toEqual([newId]);
    });
  });

  test('a public channel is visible to an ordinary member, but not to an uninvited guest', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const other = await anotherChannel(db, room);
      const { userId } = await restrict(db, room);
      const guest = await requireWorkspaceMembership(db, userId, room.workspaceId);
      expect(await visibleChannelIds(db, guest)).toEqual([room.channelId]);
      expect(await refusal(() => requireChannelById(db, userId, other))).toBe('CHANNEL_NOT_FOUND');
      const owner = room.members['owner']?.userId ?? '';
      expect((await requireChannelById(db, owner, other)).channelId).toBe(other);
    });
  });

  test('a guest gets only the declared module even outside an HTTP request context', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId, since } = await restrict(db, room);
      const guest = await requireWorkspaceMembership(db, userId, room.workspaceId);
      expect(entitledTo(guest, 'chat')).toBe(true);
      expect(entitledTo(guest, 'issues')).toBe(false);
      expect(guest.guest).toEqual({
        kind: 'guest',
        historySince: since.toISOString(),
        expiresAt: null,
      });
    });
  });

  test('a direct chat resource cannot bypass a guest’s declared module scope', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId } = await restrict(db, room);
      await db
        .updateTable('workspace_members')
        .set({ guest_modules: ['issues'] })
        .where('workspace_id', '=', room.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      const workspace = await requireWorkspaceMembership(db, userId, room.workspaceId);
      expect(entitledTo(workspace, 'chat')).toBe(false);
      expect(await visibleChannelIds(db, workspace)).toEqual([]);
      expect(await refusal(() => requireChannelById(db, userId, room.channelId))).toBe(
        'CHANNEL_NOT_FOUND',
      );
    });
  });

  test('expiry closes workspace and direct channel access even before a cleanup job removes the row', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId } = await restrict(db, room, new Date(Date.now() - 1_000));
      expect(await refusal(() => requireWorkspaceMembership(db, userId, room.workspaceId))).toBe(
        'WORKSPACE_NOT_FOUND',
      );
      expect(await refusal(() => requireChannelById(db, userId, room.channelId))).toBe(
        'CHANNEL_NOT_FOUND',
      );
      expect(
        await db
          .selectFrom('workspace_members')
          .select('id')
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', userId)
          .execute(),
      ).toHaveLength(1);
    });
  });

  test('message IDs do not open content before admission or a later channel grant', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId, since } = await restrict(db, room);
      const grant = new Date(since.getTime() + 1_000);
      await db
        .updateTable('channel_members')
        .set({ joined_at: grant })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', userId)
        .execute();
      const at = [since.getTime() - 1_000, since.getTime() + 500, grant.getTime()];
      const ids = at.map((when) => messageId(new Date(when)));
      await db
        .insertInto('messages')
        .values(
          at.map((when, i) => ({
            id: ids[i] ?? '',
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: room.members['owner']?.userId ?? '',
            content: 'Shared words',
            created_at: new Date(when),
          })),
        )
        .execute();
      for (const id of ids.slice(0, 2)) {
        expect(await refusal(() => requireMessageById(db, userId, id))).toBe('MESSAGE_NOT_FOUND');
      }
      expect((await requireMessageById(db, userId, ids[2] ?? '')).messageId).toBe(ids[2] ?? '');
      // A current full member retains the old history; this is not a global history truncation.
      expect(
        (await requireMessageById(db, room.members['owner']?.userId ?? '', ids[0] ?? '')).messageId,
      ).toBe(ids[0] ?? '');
    });
  });

  test('a direct attachment identifier cannot open a file shared before the guest joined', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId, since } = await restrict(db, room);
      const owner = room.members['owner']?.userId ?? '';
      const files: string[] = [];
      for (const delta of [-1_000, 1_000]) {
        const created = new Date(since.getTime() + delta);
        const id = messageId(created);
        await db
          .insertInto('messages')
          .values({
            id,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: owner,
            content: 'A shared file',
            created_at: created,
          })
          .execute();
        const file = await upload(db, room, owner);
        await linkFile(db, {
          id: file,
          workspaceId: room.workspaceId,
          messageId: id,
          channelId: room.channelId,
        });
        files.push(file);
      }
      expect(await refusal(() => requireAttachmentById(db, userId, files[0] ?? ''))).toBe(
        'ATTACHMENT_NOT_FOUND',
      );
      expect((await requireAttachmentById(db, userId, files[1] ?? '')).fileName).toBe(
        'supplier.pdf',
      );
      const context = await requireChannelById(db, userId, room.channelId);
      const page = await channelFiles(db, context, { limit: 1 });
      expect(page.data.map((entry) => entry.attachment.id)).toEqual([files[1] ?? '']);
      expect(page.nextCursor).toBeNull();
      expect(await attempt(db, () => channelFiles(db, context, { before: files[0] ?? '' }))).toBe(
        'VALIDATION_FAILED',
      );
      expect((await requireAttachmentById(db, owner, files[0] ?? '')).fileName).toBe(
        'supplier.pdf',
      );
    });
  });

  test('an expired guest cannot download an earlier unsent upload even while the membership row remains', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const { userId } = await restrict(db, room, new Date(Date.now() - 1_000));
      const file = await upload(db, room, userId);
      expect(await refusal(() => requireOwnUpload(db, userId, file))).toBe('ATTACHMENT_NOT_FOUND');
      expect(await refusal(() => requireAttachmentById(db, userId, file))).toBe(
        'ATTACHMENT_NOT_FOUND',
      );
    });
  });
});
