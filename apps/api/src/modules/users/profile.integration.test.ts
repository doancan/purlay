/**
 * A person's profile against the real database (#488, D-131): set, trimmed, cleared and kept; a time
 * zone the runtime does not know refused; who is told; and where it is read — the person's own
 * `/api/me`, and each workspace's members.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { meOf, membersIn } from '../workspaces/workspaces';
import { updateProfile } from './profile';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));
const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

const refusal = async (attempt: Promise<unknown>): Promise<unknown> =>
  await attempt.then(
    () => 'taken',
    (error: unknown) => (error instanceof AppError ? error.body : String(error)),
  );

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
      expect((await meOf(db, clock, alice)).profile).toEqual(set.profile);

      const kept = await updateProfile(db, alice, { status: '   ' });
      expect(kept.profile).toEqual({
        title: 'Staff engineer',
        timeZone: 'Europe/Istanbul',
        status: null,
      });

      const cleared = await updateProfile(db, alice, { title: null, timeZone: null });
      expect(cleared.profile).toEqual({ title: null, timeZone: null, status: null });
      expect((await meOf(db, clock, alice)).profile).toEqual(cleared.profile);
    });
  });

  test('a time zone the runtime does not know is refused on timeZone, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      await sql`savepoint attempt`.execute(db);
      const body = (await refusal(
        updateProfile(db, alice, { title: 'Lead', timeZone: 'Mars/Olympus_Mons' }),
      )) as { code?: string; details?: { fields?: Record<string, string> } };
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(body.details?.fields ?? {})).toEqual(['timeZone']);
      await sql`rollback to savepoint attempt`.execute(db);
      expect((await meOf(db, clock, alice)).profile.title).toBeNull();
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
      await sql`savepoint attempt`.execute(db);
      const refused = await db
        .updateTable('users')
        .set({ title: '  ' })
        .where('id', '=', idOf(room, 'alice'))
        .execute()
        .then(
          () => 'taken',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
      await sql`rollback to savepoint attempt`.execute(db);
      expect(refused).toContain('users_profile_not_blank');
    });
  });
});
