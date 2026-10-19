/**
 * A person's profile against the real database (#488, D-131): set, trimmed, cleared and kept; a time
 * zone the runtime does not know refused; who is told; and where it is read — the person's own
 * `/api/me`, and each workspace's members.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { attempt, inSavepoint } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { meOf, membersIn } from '../workspaces/workspaces';
import { workspaceCreatorsOf } from '../workspaces/creators';
import { updateProfile } from './profile';

/** What `/api/me` answers here is not about who may make a workspace (D-155). */
const ANYONE = workspaceCreatorsOf('*');

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));
const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

/** A refused attempt's body, in a savepoint (`testing/attempt.ts`); `taken` when it went through. */
const refusal = async (db: Executor, run: () => Promise<unknown>): Promise<unknown> => {
  const outcome = await inSavepoint(db, run);
  if (outcome.taken) return 'taken';
  return outcome.error instanceof AppError ? outcome.error.body : String(outcome.error);
};

describe('integration: a profile', () => {
  test('is set with its words trimmed, kept where left out, and cleared by null or by blank words', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');

      const set = await updateProfile(db, alice, {
        title: '  Staff engineer ',
        timeZone: 'Europe/Istanbul',
        status: 'On call this week',
      });
      expect(set.profile).toEqual({
        title: 'Staff engineer',
        timeZone: 'Europe/Istanbul',
        status: 'On call this week',
      });
      expect((await meOf(db, clock, alice, ANYONE)).profile).toEqual(set.profile);

      const kept = await updateProfile(db, alice, { status: '   ' });
      expect(kept.profile).toEqual({
        title: 'Staff engineer',
        timeZone: 'Europe/Istanbul',
        status: null,
      });

      const cleared = await updateProfile(db, alice, { title: null, timeZone: null });
      expect(cleared.profile).toEqual({ title: null, timeZone: null, status: null });
      expect((await meOf(db, clock, alice, ANYONE)).profile).toEqual(cleared.profile);
    });
  });

  test('a time zone the runtime does not know is refused on timeZone, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      const body = (await refusal(db, () =>
        updateProfile(db, alice, { title: 'Lead', timeZone: 'Mars/Olympus_Mons' }),
      )) as { code?: string; details?: { fields?: Record<string, string> } };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(body.details?.fields ?? {})).toEqual(['timeZone']);
      expect((await meOf(db, clock, alice, ANYONE)).profile.title).toBeNull();
    });
  });

  test('a time zone is stored as the runtime spells it, and an offset is not a zone', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      expect(
        (await updateProfile(db, alice, { timeZone: 'europe/istanbul' })).profile.timeZone,
      ).toBe('Europe/Istanbul');
      for (const offset of ['+05', '-0300']) {
        const body = (await refusal(db, () => updateProfile(db, alice, { timeZone: offset }))) as {
          code?: string;
        };
        expect({ offset, code: body.code }).toEqual({ offset, code: 'VALIDATION_FAILED' });
      }
    });
  });

  test('tells everyone in each workspace the person is in; nothing changed, nobody', async () => {
    await withRollback(async (db) => {
      const one = await aRoom(db, ['alice', 'bob']);
      const alice = idOf(one, 'alice');
      const two = await aRoom(db, ['carol']);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: two.workspaceId, user_id: alice, role: 'member' })
        .execute();

      // Nobody outside: a workspace alice is not in, one she was in and left, and one archived.
      await aRoom(db, ['dan']);
      const left = await aRoom(db, ['erin']);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: left.workspaceId, user_id: alice, role: 'member' })
        .execute();
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', left.workspaceId)
        .where('user_id', '=', alice)
        .execute();
      const archived = await aRoom(db, ['frank']);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: archived.workspaceId, user_id: alice, role: 'member' })
        .execute();
      await db
        .updateTable('workspaces')
        .set({ deleted_at: new Date() })
        .where('id', '=', archived.workspaceId)
        .execute();

      const change = await updateProfile(db, alice, { status: 'Heads down' });
      const told = Object.fromEntries(
        change.told.map(({ workspaceId, memberIds }) => [workspaceId, [...memberIds].sort()]),
      );
      expect(told).toEqual({
        [one.workspaceId]: [alice, idOf(one, 'bob')].sort(),
        [two.workspaceId]: [alice, idOf(two, 'carol')].sort(),
      });

      expect((await updateProfile(db, alice, { status: 'Heads down' })).told).toEqual([]);
      expect((await updateProfile(db, alice, {})).told).toEqual([]);
    });
  });

  test('each member of a workspace carries theirs', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await updateProfile(db, idOf(room, 'bob'), { title: 'Designer', timeZone: 'Asia/Tokyo' });
      const context = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      const members = await membersIn(db, context);
      const byName = Object.fromEntries(members.map((m) => [m.user.username, m.profile]));
      expect(Object.values(byName)).toContainEqual({
        title: 'Designer',
        timeZone: 'Asia/Tokyo',
        status: null,
      });
      expect(Object.values(byName)).toContainEqual({ title: null, timeZone: null, status: null });
    });
  });

  test('the database refuses a blank field written around the service', async () => {
    await withRollback(async (db: Executor) => {
      const room = await aRoom(db, ['alice']);
      const refused = await attempt(db, () =>
        db
          .updateTable('users')
          .set({ title: '  ' })
          .where('id', '=', idOf(room, 'alice'))
          .execute(),
      );
      expect(refused).toContain('users_profile_not_blank');
    });
  });
});
