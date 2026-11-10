/** Restricted guests must never receive notices or counter frames outside current readable history. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { aRoom, counters, notificationsOf, type Room } from '../../../testing/rooms';
import { sendMessage } from './messages';
import { reviseMessage } from './edit';
import { currentStates, notify, stillSeeing } from './delivery';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const restrict = async (db: Transaction, room: Room, now: Date): Promise<string> => {
  const guest = room.members['guest'];
  if (guest === undefined) throw new Error('Missing guest');
  await db
    .updateTable('workspace_members')
    .set({
      access_kind: 'guest',
      guest_since: new Date(now.getTime() - 30_000),
      guest_modules: ['chat'],
    })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', guest.userId)
    .execute();
  await db
    .updateTable('channel_members')
    .set({ joined_at: new Date(now.getTime() - 30_000) })
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', guest.userId)
    .execute();
  return guest.userId;
};

describe('integration: restricted guest delivery', () => {
  test('a public-channel mention grants no notification to an uninvited guest', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const now = new Date();
      const guestId = await restrict(db, room, now);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', guestId)
        .execute();
      const other = await db
        .insertInto('channels')
        .values({ workspace_id: room.workspaceId, name: 'granted-elsewhere', type: 'public' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: other.id, user_id: guestId })
        .execute();
      const owner = room.members['owner'];
      if (owner === undefined) throw new Error('Missing sender');
      const sent = await sendMessage(db, fixedClock(now), owner.context, {
        id: messageId(now),
        content: `@${room.members['guest']?.username ?? ''} private to this scope`,
      });
      expect(sent.told).not.toContain(guestId);
      expect(await stillSeeing(db, owner.context, [guestId])).toEqual(new Set());
      expect(
        await notify(
          db,
          owner.context,
          { id: sent.message.id, reply: false },
          new Map([[guestId, 'mention']]),
          now,
        ),
      ).toEqual([]);
      expect(await notificationsOf(db, guestId)).toEqual([]);
      expect(
        await db
          .selectFrom('mentions')
          .select('mentioned_user_id')
          .where('message_id', '=', sent.message.id)
          .execute(),
      ).toEqual([]);
    });
  });

  test.each(['expired', 'future', 'module', 'suspended', 'deleted'] as const)(
    '%s guests receive neither a notice nor a counter update',
    async (state) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['owner', 'guest']);
        const now = new Date();
        const guestId = await restrict(db, room, now);
        await db
          .updateTable('workspace_members')
          .set({
            guest_expires_at: null,
            ...(state === 'expired' ? { guest_expires_at: new Date(now.getTime() - 1_000) } : {}),
            ...(state === 'future' ? { guest_since: new Date(now.getTime() + 3_600_000) } : {}),
            ...(state === 'module' ? { guest_modules: ['issues'] } : {}),
          })
          .where('workspace_id', '=', room.workspaceId)
          .where('user_id', '=', guestId)
          .execute();
        if (state === 'suspended')
          await db
            .updateTable('users')
            .set({ suspended_at: now })
            .where('id', '=', guestId)
            .execute();
        if (state === 'deleted')
          await db
            .updateTable('users')
            .set({ deleted_at: now })
            .where('id', '=', guestId)
            .execute();
        const owner = room.members['owner'];
        if (owner === undefined) throw new Error('Missing sender');
        const sent = await sendMessage(db, fixedClock(now), owner.context, {
          id: messageId(now),
          content: `@${room.members['guest']?.username ?? ''} new message`,
        });
        expect(sent.told).not.toContain(guestId);
        expect(await stillSeeing(db, owner.context, [guestId])).toEqual(new Set());
        expect(
          await notify(
            db,
            owner.context,
            { id: sent.message.id, reply: false },
            new Map([[guestId, 'mention']]),
            now,
          ),
        ).toEqual([]);
        expect(sent.recipients.map((row) => row.userId)).not.toContain(guestId);
        expect(await notificationsOf(db, guestId)).toEqual([]);
        expect(await counters(db, room, guestId)).toMatchObject({ unread: 0, mentions: 0 });
        expect((await currentStates(db, owner.context)).map((row) => row.userId)).not.toContain(
          guestId,
        );
      });
    },
  );

  test('editing an earlier message cannot notify or mention a later guest; full members retain history', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest'], { outsiders: ['normal'] });
      const now = new Date();
      const guestId = await restrict(db, room, now);
      const owner = room.members['owner'];
      const normal = room.outsiders['normal'];
      if (owner === undefined || normal === undefined) throw new Error('Missing people');
      const oldAt = new Date(now.getTime() - 120_000);
      const oldId = messageId(oldAt);
      await db
        .insertInto('messages')
        .values({
          id: oldId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: owner.userId,
          created_at: oldAt,
          content: 'Before guest admission',
        })
        .execute();
      const revised = await reviseMessage(
        db,
        fixedClock(now),
        owner.userId,
        oldId,
        `@${room.members['guest']?.username ?? ''} @${normal.username} earlier material`,
      );
      expect(revised.told).toEqual([normal.userId]);
      expect(
        await notify(
          db,
          owner.context,
          { id: oldId, reply: false },
          new Map([[guestId, 'mention']]),
          now,
          oldAt,
        ),
      ).toEqual([]);
      expect(await notificationsOf(db, guestId)).toEqual([]);
      expect(
        await db
          .selectFrom('mentions')
          .select('mentioned_user_id')
          .where('message_id', '=', oldId)
          .execute(),
      ).toEqual([{ mentioned_user_id: normal.userId }]);
      expect(await counters(db, room, guestId)).toMatchObject({ unread: 0, mentions: 0 });
      await db.updateTable('messages').set({ deleted_at: now }).where('id', '=', oldId).execute();
      expect(
        await notify(
          db,
          owner.context,
          { id: oldId, reply: false },
          new Map([[normal.userId, 'channel_message']]),
          now,
          oldAt,
        ),
      ).toEqual([]);
    });
  });

  test('new message authority uses server-created time even when its UUID sorts before admission', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const now = new Date();
      const guestId = await restrict(db, room, now);
      const owner = room.members['owner'];
      if (owner === undefined) throw new Error('Missing sender');
      const sent = await sendMessage(db, fixedClock(now), owner.context, {
        id: messageId(new Date(now.getTime() - 45_000)),
        content: `@${room.members['guest']?.username ?? ''} readable new message`,
      });
      expect(sent.told).toContain(guestId);
      expect((await notificationsOf(db, guestId)).map((row) => row.messageId)).toEqual([
        sent.message.id,
      ]);
      expect(await counters(db, room, guestId)).toMatchObject({ unread: 1, mentions: 1 });
    });
  });

  test('a send created before the guest history floor cannot mention them even under clock skew', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'guest']);
      const now = new Date();
      const guestId = await restrict(db, room, now);
      const owner = room.members['owner'];
      if (owner === undefined) throw new Error('Missing sender');
      const earlier = new Date(now.getTime() - 60_000);
      const sent = await sendMessage(db, fixedClock(earlier), owner.context, {
        id: messageId(earlier),
        content: `@${room.members['guest']?.username ?? ''} earlier server timestamp`,
      });
      expect(sent.told).not.toContain(guestId);
      expect(sent.recipients.map((row) => row.userId)).not.toContain(guestId);
      expect(
        await db
          .selectFrom('mentions')
          .select('mentioned_user_id')
          .where('message_id', '=', sent.message.id)
          .execute(),
      ).toEqual([]);
      expect(await counters(db, room, guestId)).toMatchObject({ unread: 0, mentions: 0 });
    });
  });
});
