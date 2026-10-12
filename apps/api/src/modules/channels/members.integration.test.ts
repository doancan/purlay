/**
 * Private channels, and bringing people into a channel (D-104): any member brings in somebody from
 * the workspace; nobody else can, and a direct message stays between its two people.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireChannelById, visibleChannelIds } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRoom, type Room } from '../../testing/rooms';
import { addMember } from './members';
import { createChannel } from './channels';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};
const outsider = (room: Room, name: string): string => {
  const found = room.outsiders[name];
  if (found === undefined) throw new Error(`no outsider ${name}`);
  return found.userId;
};

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('expected a refusal, and the attempt succeeded');
};

const canSee = async (db: Executor, room: Room, userId: string): Promise<boolean> => {
  const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
  return (await visibleChannelIds(db, context)).includes(room.channelId);
};

describe('integration: a private channel', () => {
  test('is made private, with its creator in it, and is seen by nobody else', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['olga'] });
      const context = await requireWorkspaceMembership(
        db,
        member(room, 'alice').userId,
        room.workspaceId,
      );
      const channel = await atomicallyOn(db)(
        async (transaction) =>
          await createChannel(transaction, clock, context, { name: 'leads', type: 'private' }),
      );
      expect(channel.type).toBe('private');
      const olga = await requireWorkspaceMembership(db, outsider(room, 'olga'), room.workspaceId);
      expect(await visibleChannelIds(db, olga)).not.toContain(channel.id);
      expect(await visibleChannelIds(db, context)).toContain(channel.id);
    });
  });

  test('is public when the type is not given', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const context = await requireWorkspaceMembership(
        db,
        member(room, 'alice').userId,
        room.workspaceId,
      );
      const channel = await atomicallyOn(db)(
        async (transaction) => await createChannel(transaction, clock, context, { name: 'all' }),
      );
      expect(channel.type).toBe('public');
    });
  });
});

describe('integration: a member brings somebody in', () => {
  test('into a private channel: they see it, and are told it is theirs now', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private', outsiders: ['olga'] });
      expect(await canSee(db, room, outsider(room, 'olga'))).toBe(false);
      const added = await addMember(
        db,
        clock,
        member(room, 'alice').context,
        outsider(room, 'olga'),
      );
      expect(added.forMember?.id).toBe(room.channelId);
      expect(added.forMember?.type).toBe('private');
      expect(await canSee(db, room, outsider(room, 'olga'))).toBe(true);
      const joined = await db
        .selectFrom('channel_members')
        .select('joined_at')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', outsider(room, 'olga'))
        .executeTakeFirstOrThrow();
      expect(new Date(joined.joined_at).toISOString()).toBe(NOW.toISOString());
    });
  });

  test('somebody already in it is the same answer, and nobody is told again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private' });
      const added = await addMember(
        db,
        clock,
        member(room, 'alice').context,
        member(room, 'bob').userId,
      );
      expect(added.forMember).toBeNull();
    });
  });

  test('somebody outside the workspace, or who never was, is not there', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private' });
      const other = await aRoom(db, ['eve']);
      expect(
        await refusal(
          addMember(db, clock, member(room, 'alice').context, member(other, 'eve').userId),
        ),
      ).toBe('USER_NOT_FOUND');
      expect(
        await refusal(
          addMember(
            db,
            clock,
            member(room, 'alice').context,
            '0190a5b0-0000-7000-8000-000000000000',
          ),
        ),
      ).toBe('USER_NOT_FOUND');
    });
  });

  test('a deleted account is not there either', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { type: 'private', outsiders: ['olga'] });
      await db
        .updateTable('users')
        .set({ deleted_at: NOW })
        .where('id', '=', outsider(room, 'olga'))
        .execute();
      expect(
        await refusal(addMember(db, clock, member(room, 'alice').context, outsider(room, 'olga'))),
      ).toBe('USER_NOT_FOUND');
    });
  });
});

describe('integration: who may not', () => {
  test('a direct message stays between its two people', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], {
        type: 'direct_message',
        outsiders: ['olga'],
      });
      expect(
        await refusal(addMember(db, clock, member(room, 'alice').context, outsider(room, 'olga'))),
      ).toBe('FORBIDDEN');
      expect(await canSee(db, room, outsider(room, 'olga'))).toBe(false);
    });
  });

  test('somebody who can see a public channel but is not in it cannot bring others in', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['olga', 'pat'] });
      // Olga sees the public channel without being in it: the guard gives her a context.
      const olga = await requireChannelById(db, outsider(room, 'olga'), room.channelId);
      expect(await refusal(addMember(db, clock, olga, outsider(room, 'pat')))).toBe('FORBIDDEN');
      const rows = await db
        .selectFrom('channel_members')
        .select('user_id')
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', outsider(room, 'pat'))
        .execute();
      expect(rows).toEqual([]);
    });
  });
});
