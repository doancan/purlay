/** Storage behavior, owner boundaries and the one-placement rule against real SQL (#1198). */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { CHANNEL_GROUP_LIMIT } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { aRoom, type Room } from '../../../testing/rooms';
import { channelFor, joinChannel } from './channels';
import { foldGroup, listGroups, moveToGroup, removeGroup, saveGroup } from './groups';
import { channelNotFound, type ChannelContext } from './guard';
import { leaveChannel } from './settings';
import { setStarred } from './star';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const clock = fixedClock(new Date('2026-11-07T12:00:00.000Z'));
const member = (room: Room, name = 'alice'): ChannelContext => {
  const found = room.members[name]?.context;
  if (found === undefined) throw new Error('missing fixture member');
  return found;
};
const scope = async (db: Executor, room: Room, name = 'alice'): Promise<WorkspaceContext> =>
  await requireWorkspaceMembership(db, member(room, name).userId, room.workspaceId);

const refusal = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    return await promise;
  } catch (failure) {
    return failure;
  }
};

describe('integration: personal channel group storage', () => {
  test('a retry changes nothing, rename preserves folding, and names are trimmed and compared without case', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const context = await scope(db, room);
      const id = crypto.randomUUID();
      const made = await saveGroup(db, context, id, '  Finans  ');
      expect(made).toEqual({ group: { id, name: 'Finans', collapsed: false }, changed: true });
      expect((await saveGroup(db, context, id, 'Finans')).changed).toBe(false);
      expect((await foldGroup(db, context, id, true)).changed).toBe(true);
      expect((await foldGroup(db, context, id, true)).changed).toBe(false);
      expect((await saveGroup(db, context, id, 'Operasyon')).group.collapsed).toBe(true);
      expect((await listGroups(db, await scope(db, room, 'bob'), {})).data).toEqual([]);
      expect(await refusal(saveGroup(db, context, crypto.randomUUID(), 'OPERASYON'))).toMatchObject(
        {
          body: { code: 'CHANNEL_GROUP_NAME_TAKEN' },
        },
      );
      expect(await refusal(saveGroup(db, context, crypto.randomUUID(), '   '))).toMatchObject({
        body: { code: 'VALIDATION_FAILED' },
      });
      expect(await refusal(saveGroup(db, context, 'bad', 'Valid'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
    });
  });

  test('pages are bounded and disjoint; the cap applies only to creation, not retry or rename', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const context = await scope(db, room);
      const ids: string[] = [];
      for (let index = 0; index < CHANNEL_GROUP_LIMIT; index += 1) {
        const id = crypto.randomUUID();
        ids.push(id);
        await saveGroup(db, context, id, `Department ${String(index)}`);
      }
      expect(await refusal(saveGroup(db, context, crypto.randomUUID(), 'One more'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_LIMIT' },
      });
      const first = ids[0];
      if (first === undefined) throw new Error('empty fixture');
      expect((await saveGroup(db, context, first, 'Renamed')).changed).toBe(true);
      expect((await saveGroup(db, context, first, 'Renamed')).changed).toBe(false);
      const page = await listGroups(db, context, { limit: 1 });
      expect(page.data).toHaveLength(1);
      expect(page.nextCursor).toBe(page.data[0]?.id ?? null);
      const rest = await listGroups(db, context, { before: page.nextCursor ?? '', limit: 100 });
      expect(rest.data).toHaveLength(CHANNEL_GROUP_LIMIT - 1);
      expect(rest.nextCursor).toBeNull();
      expect(new Set([...page.data, ...rest.data].map((group) => group.id)).size).toBe(
        CHANNEL_GROUP_LIMIT,
      );
    });
  });

  test('a colleague cannot rename, fold, delete or use another person’s group', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = await scope(db, room);
      const bob = await scope(db, room, 'bob');
      const id = crypto.randomUUID();
      await saveGroup(db, alice, id, 'Private heading');
      expect(await refusal(saveGroup(db, bob, id, 'Private heading'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect(await refusal(saveGroup(db, bob, id, 'Taken'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect(await refusal(foldGroup(db, bob, id, true))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect(await removeGroup(db, bob, id)).toBe(false);
      expect(await refusal(moveToGroup(db, member(room, 'bob'), id))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect((await listGroups(db, alice, {})).data[0]?.name).toBe('Private heading');
      expect((await saveGroup(db, bob, crypto.randomUUID(), 'Private heading')).changed).toBe(true);
    });
  });

  test('even the same person cannot use a heading from another workspace', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const elsewhere = await aRoom(db, ['other']);
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: elsewhere.workspaceId,
          user_id: member(room).userId,
          role: 'member',
        })
        .execute();
      const context = await requireWorkspaceMembership(
        db,
        member(room).userId,
        elsewhere.workspaceId,
      );
      const id = crypto.randomUUID();
      await saveGroup(db, context, id, 'Elsewhere');
      expect(await refusal(moveToGroup(db, member(room), id))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect(await refusal(saveGroup(db, await scope(db, room), id, 'Taken'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect((await channelFor(db, member(room).userId, room.channelId)).sidebarGroupId).toBeNull();
    });
  });

  test('moving unstars, starring clears placement, and letting go of a star never resurrects the old group', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const context = member(room);
      const id = crypto.randomUUID();
      await saveGroup(db, await scope(db, room), id, 'Sales');
      expect(await refusal(moveToGroup(db, context, 'bad'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      await setStarred(db, clock, context, true);
      expect(await moveToGroup(db, context, id)).toBe(true);
      expect(await moveToGroup(db, context, id)).toBe(false);
      expect(await channelFor(db, context.userId, context.channelId)).toMatchObject({
        starred: false,
        sidebarGroupId: id,
      });
      expect(
        (await channelFor(db, member(room, 'bob').userId, context.channelId)).sidebarGroupId,
      ).toBeNull();
      await setStarred(db, clock, context, true);
      await setStarred(db, clock, context, false);
      expect(await channelFor(db, context.userId, context.channelId)).toMatchObject({
        starred: false,
        sidebarGroupId: null,
      });
      expect(await moveToGroup(db, context, null)).toBe(false);
      await setStarred(db, clock, context, true);
      expect(await moveToGroup(db, context, null)).toBe(true);
    });
  });

  test('deletion returns a channel to the default section without leaving it; absence is repeatable', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const context = await scope(db, room);
      const id = crypto.randomUUID();
      await saveGroup(db, context, id, 'Finance');
      await moveToGroup(db, member(room), id);
      expect(await removeGroup(db, context, id)).toBe(true);
      expect(await removeGroup(db, context, id)).toBe(false);
      const channel = await channelFor(db, context.userId, room.channelId);
      expect(channel.sidebarGroupId).toBeNull();
      expect(channel.state).not.toBeNull();
      expect(await refusal(foldGroup(db, context, id, true))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect(await refusal(removeGroup(db, context, 'bad'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect(await refusal(foldGroup(db, context, 'bad', false))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
    });
  });

  test('DMs and a public channel’s unjoined viewer cannot be placed', async () => {
    await withRollback(async (db) => {
      const dm = await aRoom(db, ['alice', 'bob'], { type: 'direct_message' });
      expect(await refusal(moveToGroup(db, member(dm), null))).toMatchObject({
        body: { code: channelNotFound().body.code },
      });
      const room = await aRoom(db, ['alice'], { outsiders: ['carol'] });
      const user = room.outsiders['carol'];
      if (user === undefined) throw new Error('missing carol');
      const { requireChannelById } = await import('./guard');
      const outsider = await requireChannelById(db, user.userId, room.channelId);
      expect(await refusal(moveToGroup(db, outsider, null))).toMatchObject({
        body: { code: 'CHANNEL_NOT_FOUND' },
      });
    });
  });

  test('leaving and rejoining does not restore placement; an obsolete workspace context cannot create a group', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const context = await scope(db, room);
      const id = crypto.randomUUID();
      await saveGroup(db, context, id, 'Operations');
      await moveToGroup(db, member(room), id);
      await leaveChannel(db, member(room));
      await joinChannel(db, clock, member(room));
      expect((await channelFor(db, context.userId, room.channelId)).sidebarGroupId).toBeNull();
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', context.workspaceId)
        .where('user_id', '=', context.userId)
        .execute();
      expect(await refusal(saveGroup(db, context, crypto.randomUUID(), 'Gone'))).toMatchObject({
        body: { code: 'CHANNEL_GROUP_NOT_FOUND' },
      });
      expect((await listGroups(db, context, {})).data).toEqual([]);
    });
  });
});
