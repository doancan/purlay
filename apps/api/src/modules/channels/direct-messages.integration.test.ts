/**
 * Opening a direct message: one channel per pair, whoever opens it and however
 * often (I-5, D-99 §7).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aConversation } from '../../testing/conversations';
import type { TestUser } from '../../testing/users';
import { directMessageKey, openDirectMessage } from './direct-messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

describe('integration: the pair key', () => {
  test('is the two ids in ascending order, whichever asks', () => {
    expect(directMessageKey('b', 'a')).toBe('a:b');
    expect(directMessageKey('a', 'b')).toBe('a:b');
    expect(directMessageKey('a', 'a')).toBe('a:a');
  });
});

describe('integration: opening a direct message', () => {
  test('creates it, makes both people members, and says it was created', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'dm-ann', 'dm-ben');
      const [ann, ben] = users as [TestUser, TestUser];
      const context = await requireWorkspaceMembership(db, ann.userId, workspaceId);

      const opened = await openDirectMessage(db, clock, context, ben.userId);
      expect(opened.created).toBe(true);
      expect(opened.channel.type).toBe('direct_message');
      expect(opened.channel.name).toBeNull();
      expect(opened.channel.state).toEqual({
        lastReadMessageId: null,
        unreadCount: 0,
        unreadMentionCount: 0,
      });
      expect(opened.forPeer?.id).toBe(opened.channel.id);

      const members = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', opened.channel.id)
        .execute();
      expect(members.map((row) => row.user_id).sort()).toEqual([ann.userId, ben.userId].sort());
    });
  });

  test('the same pair gets the same channel, from either side, and only the first call creates it', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'dm-cam', 'dm-dee');
      const [cam, dee] = users as [TestUser, TestUser];
      const camContext = await requireWorkspaceMembership(db, cam.userId, workspaceId);
      const deeContext = await requireWorkspaceMembership(db, dee.userId, workspaceId);

      const first = await openDirectMessage(db, clock, camContext, dee.userId);
      const again = await openDirectMessage(db, clock, camContext, dee.userId);
      const fromThere = await openDirectMessage(db, clock, deeContext, cam.userId);

      expect([again.channel.id, fromThere.channel.id]).toEqual([
        first.channel.id,
        first.channel.id,
      ]);
      expect([again.created, fromThere.created]).toEqual([false, false]);
      // The other person is told once, when it came into being, and not on a retry.
      expect([again.forPeer, fromThere.forPeer]).toEqual([null, null]);
      const channels = await db
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('type', '=', 'direct_message')
        .execute();
      expect(channels).toHaveLength(1);
    });
  });

  test('a note to self is a direct message with one member, created once, and tells nobody', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'dm-eve');
      const [eve] = users as [TestUser];
      const context = await requireWorkspaceMembership(db, eve.userId, workspaceId);

      const first = await openDirectMessage(db, clock, context, eve.userId);
      expect(first.created).toBe(true);
      expect(first.forPeer).toBeNull();
      expect(first.channel.peer?.id).toBe(eve.userId);
      const members = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', first.channel.id)
        .execute();
      expect(members).toHaveLength(1);
      expect((await openDirectMessage(db, clock, context, eve.userId)).created).toBe(false);
    });
  });

  test('a membership that went missing is restored rather than leaving a conversation one person cannot open', async () => {
    await withRollback(async (db) => {
      const { workspaceId, users } = await aConversation(db, 'dm-fay', 'dm-gus');
      const [fay, gus] = users as [TestUser, TestUser];
      const context = await requireWorkspaceMembership(db, fay.userId, workspaceId);
      const opened = await openDirectMessage(db, clock, context, gus.userId);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', opened.channel.id)
        .where('user_id', '=', gus.userId)
        .execute();

      await openDirectMessage(db, clock, context, gus.userId);
      const restored = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', opened.channel.id)
        .execute();
      expect(restored).toHaveLength(2);
    });
  });

  test('a stranger, a member of another workspace and an erased account are the same refusal', async () => {
    await withRollback(async (db) => {
      const mine = await aConversation(db, 'dm-hal', 'dm-ida');
      const other = await aConversation(db, 'dm-jon');
      const [hal, ida] = mine.users as [TestUser, TestUser];
      const context = await requireWorkspaceMembership(db, hal.userId, mine.workspaceId);
      await db
        .updateTable('users')
        .set({ deleted_at: new Date('2026-01-01T00:00:00.000Z') })
        .where('id', '=', ida.userId)
        .execute();

      const refusals: unknown[] = [];
      for (const target of [ida.userId, other.users[0]?.userId ?? '', crypto.randomUUID()]) {
        refusals.push(await openDirectMessage(db, clock, context, target).catch((t: unknown) => t));
      }
      for (const refusal of refusals) {
        expect(refusal).toMatchObject({ status: 404, body: { code: 'USER_NOT_FOUND' } });
      }
      expect(refusals[1]).toEqual(refusals[0]);
      expect(refusals[2]).toEqual(refusals[0]);
    });
  });
});
