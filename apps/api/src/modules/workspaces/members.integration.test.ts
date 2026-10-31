/**
 * Managing a workspace's members (`ARCHITECTURE.md` §7.4, invariant I-2, #51): who may change a role
 * or remove somebody, what making somebody an owner takes, that the last owner stays, and what a
 * removed member loses — every channel of the workspace, which the caller is told about to tell the
 * sockets.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
} from '@purlay/db';
import type { UserRole } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRoom, type Room } from '../../testing/rooms';
import { fixedClock } from '../../platform/clock';
import { changeRole, removeMember } from './members';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const idOf = (room: Room, name: string): string => {
  const found = room.members[name] ?? room.outsiders[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found.userId;
};

const as = async (db: Executor, room: Room, name: string): Promise<WorkspaceContext> =>
  await requireWorkspaceMembership(db, idOf(room, name), room.workspaceId);

const roleOf = async (db: Executor, room: Room, name: string): Promise<UserRole | undefined> =>
  (
    await db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', idOf(room, name))
      .executeTakeFirst()
  )?.role;

const setRole = async (db: Executor, room: Room, name: string, role: UserRole): Promise<void> => {
  await db
    .updateTable('workspace_members')
    .set({ role })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', idOf(room, name))
    .execute();
};

const refusalOf = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  return 'accepted';
};

describe('integration: changing a role', () => {
  test('an owner may make a member an admin, and back; the answer is the member as listed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const changed = await changeRole(
        db,
        clock,
        await as(db, room, 'alice'),
        idOf(room, 'bob'),
        'admin',
      );
      expect(changed).toMatchObject({ user: { id: idOf(room, 'bob') }, role: 'admin' });
      await changeRole(db, clock, await as(db, room, 'alice'), idOf(room, 'bob'), 'member');
      expect(await roleOf(db, room, 'bob')).toBe('member');
    });
  });

  test('an admin manages members and admins, but makes nobody an owner and touches no owner', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await setRole(db, room, 'bob', 'admin');
      const bob = await as(db, room, 'bob');
      await changeRole(db, clock, bob, idOf(room, 'carol'), 'admin');
      expect(await roleOf(db, room, 'carol')).toBe('admin');
      expect(await refusalOf(changeRole(db, clock, bob, idOf(room, 'carol'), 'owner'))).toBe(
        'FORBIDDEN',
      );
      expect(await refusalOf(changeRole(db, clock, bob, idOf(room, 'alice'), 'member'))).toBe(
        'FORBIDDEN',
      );
      expect(await refusalOf(removeMember(db, clock, bob, idOf(room, 'alice')))).toBe('FORBIDDEN');
    });
  });

  test('a member manages nobody, themself included', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const bob = await as(db, room, 'bob');
      expect(await refusalOf(changeRole(db, clock, bob, idOf(room, 'carol'), 'admin'))).toBe(
        'FORBIDDEN',
      );
      expect(await refusalOf(changeRole(db, clock, bob, idOf(room, 'bob'), 'admin'))).toBe(
        'FORBIDDEN',
      );
      expect(await refusalOf(removeMember(db, clock, bob, idOf(room, 'carol')))).toBe('FORBIDDEN');
    });
  });

  test('ownership is handed over by making another owner; then the first may step down', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = await as(db, room, 'alice');
      expect(await refusalOf(changeRole(db, clock, alice, idOf(room, 'alice'), 'member'))).toBe(
        'LAST_OWNER',
      );
      expect(await refusalOf(removeMember(db, clock, alice, idOf(room, 'alice')))).toBe(
        'LAST_OWNER',
      );
      await changeRole(db, clock, alice, idOf(room, 'bob'), 'owner');
      await changeRole(db, clock, alice, idOf(room, 'alice'), 'member');
      expect([await roleOf(db, room, 'alice'), await roleOf(db, room, 'bob')]).toEqual([
        'member',
        'owner',
      ]);
    });
  });

  test('somebody who is not in the workspace, or no id at all, is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const elsewhere = await aRoom(db, ['dave']);
      const alice = await as(db, room, 'alice');
      expect(await refusalOf(changeRole(db, clock, alice, idOf(elsewhere, 'dave'), 'admin'))).toBe(
        'USER_NOT_FOUND',
      );
      expect(await refusalOf(removeMember(db, clock, alice, 'not-a-uuid'))).toBe('USER_NOT_FOUND');
    });
  });
});

/** A channel of the room's workspace, private or public, with these of its people in it. */
const aChannelIn = async (
  db: Executor,
  room: Room,
  name: string,
  type: 'public' | 'private',
  people: readonly string[],
): Promise<string> => {
  const { id } = await db
    .insertInto('channels')
    .values({ workspace_id: room.workspaceId, name, type })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const person of people) {
    await db
      .insertInto('channel_members')
      .values({ channel_id: id, user_id: idOf(room, person), joined_at: new Date(0) })
      .execute();
  }
  return id;
};

describe('integration: removing a member', () => {
  test('takes their membership and their channels here, and names every channel they could see', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const theirSecret = await aChannelIn(db, room, 'plans', 'private', ['alice', 'bob']);
      const notTheirs = await aChannelIn(db, room, 'board', 'private', ['alice']);
      const publicUnjoined = await aChannelIn(db, room, 'random', 'public', ['alice']);
      const elsewhere = await aRoom(db, ['carol']);
      await db
        .insertInto('channel_members')
        .values({
          channel_id: elsewhere.channelId,
          user_id: idOf(room, 'bob'),
          joined_at: new Date(0),
        })
        .execute();

      const removed = await removeMember(db, clock, await as(db, room, 'alice'), idOf(room, 'bob'));
      // What they could see: the public channels, joined or not, and the private ones they were in.
      expect([...removed.channelIds].sort()).toEqual(
        [room.channelId, theirSecret, publicUnjoined].sort(),
      );
      expect(removed.channelIds).not.toContain(notTheirs);
      expect(await roleOf(db, room, 'bob')).toBeUndefined();
      const left = await db
        .selectFrom('channel_members')
        .select('channel_id')
        .where('user_id', '=', idOf(room, 'bob'))
        .execute();
      // Only another workspace's channel is left: it is not this workspace's to take.
      expect(left.map((row) => row.channel_id)).toEqual([elsewhere.channelId]);
    });
  });

  test('an admin may remove a member; nobody may be removed twice', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await setRole(db, room, 'bob', 'admin');
      const bob = await as(db, room, 'bob');
      await removeMember(db, clock, bob, idOf(room, 'carol'));
      expect(await refusalOf(removeMember(db, clock, bob, idOf(room, 'carol')))).toBe(
        'USER_NOT_FOUND',
      );
    });
  });
});

describe('integration: two owners stepping down at once', () => {
  test('one does, the other is told it would leave no owner: never none (I-2)', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob']);
    await setRole(db, room, 'bob', 'owner');
    const step = async (who: string, other: string): Promise<string> =>
      await refusalOf(
        atomicallyOn(db)(async (transaction) => {
          const context = await requireWorkspaceMembership(
            transaction,
            idOf(room, who),
            room.workspaceId,
          );
          return await changeRole(transaction, clock, context, idOf(room, other), 'member');
        }),
      );
    const outcomes = await Promise.all([step('alice', 'bob'), step('bob', 'alice')]);
    // Whoever waited acts on the roles as they are once it holds the lock: no longer an owner.
    expect([...outcomes].sort()).toEqual(['FORBIDDEN', 'accepted']);
    const owners = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', room.workspaceId)
      .where('role', '=', 'owner')
      .execute();
    expect(owners).toHaveLength(1);
  });
});
