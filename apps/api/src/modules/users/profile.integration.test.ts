/**
 * A person's profile against the real database (#488, D-131): set, trimmed, cleared and kept; a time
 * zone the runtime does not know refused; who is told; and where it is read — the person's own
 * `/api/me`, and each workspace's members.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock, HOUR_MS } from '../../platform/clock';
import { aMovableClock } from '../../testing/doubles';
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

      const set = await updateProfile(db, clock, alice, {
        title: '  Staff engineer ',
        timeZone: 'Europe/Istanbul',
        status: 'On call this week',
        statusEmoji: null,
        statusUntil: null,
      });
      expect(set.profile).toEqual({
        title: 'Staff engineer',
        timeZone: 'Europe/Istanbul',
        status: 'On call this week',
        statusEmoji: null,
        statusUntil: null,
      });
      expect((await meOf(db, clock, alice, ANYONE)).profile).toEqual(set.profile);

      const kept = await updateProfile(db, clock, alice, { status: '   ' });
      expect(kept.profile).toEqual({
        title: 'Staff engineer',
        timeZone: 'Europe/Istanbul',
        status: null,
        statusEmoji: null,
        statusUntil: null,
      });

      const cleared = await updateProfile(db, clock, alice, { title: null, timeZone: null });
      expect(cleared.profile).toEqual({
        title: null,
        timeZone: null,
        status: null,
        statusEmoji: null,
        statusUntil: null,
      });
      expect((await meOf(db, clock, alice, ANYONE)).profile).toEqual(cleared.profile);
    });
  });

  test('a time zone the runtime does not know is refused on timeZone, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      const body = (await refusal(db, () =>
        updateProfile(db, clock, alice, { title: 'Lead', timeZone: 'Mars/Olympus_Mons' }),
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
        (await updateProfile(db, clock, alice, { timeZone: 'europe/istanbul' })).profile.timeZone,
      ).toBe('Europe/Istanbul');
      for (const offset of ['+05', '-0300']) {
        const body = (await refusal(db, () =>
          updateProfile(db, clock, alice, { timeZone: offset }),
        )) as {
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

      const change = await updateProfile(db, clock, alice, { status: 'Heads down' });
      const told = Object.fromEntries(
        change.told.map(({ workspaceId, memberIds }) => [workspaceId, [...memberIds].sort()]),
      );
      expect(told).toEqual({
        [one.workspaceId]: [alice, idOf(one, 'bob')].sort(),
        [two.workspaceId]: [alice, idOf(two, 'carol')].sort(),
      });

      expect((await updateProfile(db, clock, alice, { status: 'Heads down' })).told).toEqual([]);
      expect((await updateProfile(db, clock, alice, {})).told).toEqual([]);
    });
  });

  test('each member of a workspace carries theirs', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await updateProfile(db, clock, idOf(room, 'bob'), {
        title: 'Designer',
        timeZone: 'Asia/Tokyo',
      });
      const context = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      const members = await membersIn(db, context, clock.now());
      const byName = Object.fromEntries(members.map((m) => [m.user.username, m.profile]));
      expect(Object.values(byName)).toContainEqual({
        title: 'Designer',
        timeZone: 'Asia/Tokyo',
        status: null,
        statusEmoji: null,
        statusUntil: null,
      });
      expect(Object.values(byName)).toContainEqual({
        title: null,
        timeZone: null,
        status: null,
        statusEmoji: null,
        statusUntil: null,
      });
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

describe('integration: a status line that clears itself (D-330)', () => {
  const START = new Date('2026-10-14T12:00:00.000Z');
  const inHours = (hours: number): string =>
    new Date(START.getTime() + hours * HOUR_MS).toISOString();

  test('words, emoji and end are kept together, read by everyone, and gone for every reader at the end', async () => {
    await withRollback(async (db) => {
      const at = aMovableClock(START);
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = idOf(room, 'alice');
      const until = inHours(1);
      const set = await updateProfile(db, at, alice, {
        status: '  Öğle yemeğinde — İstanbul ',
        statusEmoji: '🍽️',
        statusUntil: until,
      });
      expect(set.profile).toMatchObject({
        status: 'Öğle yemeğinde — İstanbul',
        statusEmoji: '🍽️',
        statusUntil: until,
      });
      expect(set.told.length).toBe(1);
      const bob = await requireWorkspaceMembership(db, idOf(room, 'bob'), room.workspaceId);
      const seen = async (): Promise<unknown> =>
        (await membersIn(db, bob, at.now())).find((m) => m.user.id === alice)?.profile;
      expect(await seen()).toMatchObject({
        status: 'Öğle yemeğinde — İstanbul',
        statusUntil: until,
      });

      at.advance(HOUR_MS - 1);
      expect((await meOf(db, at, alice, ANYONE)).profile.statusEmoji).toBe('🍽️');
      at.advance(1);
      const cleared = { status: null, statusEmoji: null, statusUntil: null };
      expect((await meOf(db, at, alice, ANYONE)).profile).toMatchObject(cleared);
      expect(await seen()).toMatchObject(cleared);
      // Writing nothing new after the end changes nothing anybody is told of.
      expect((await updateProfile(db, at, alice, { title: null })).told).toEqual([]);
    });
  });

  test('yesterday’s client sends the words alone: the line is for good, its old emoji and end gone', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      await updateProfile(db, clock, alice, {
        status: 'In a meeting',
        statusEmoji: '📅',
        statusUntil: inHours(1),
      });
      const words = await updateProfile(db, clock, alice, { status: 'Heads down' });
      expect(words.profile).toMatchObject({
        status: 'Heads down',
        statusEmoji: null,
        statusUntil: null,
      });
      // A title changed alone leaves the line as it is.
      await updateProfile(db, clock, alice, { status: 'Lunch', statusUntil: inHours(2) });
      const titled = await updateProfile(db, clock, alice, { title: 'Lead' });
      expect(titled.profile).toMatchObject({ status: 'Lunch', statusUntil: inHours(2) });
    });
  });

  test('an emoji alone is a line; an end with nothing to clear is not kept', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      const family = '👩‍👩‍👧';
      expect(
        (await updateProfile(db, clock, alice, { statusEmoji: family, statusUntil: inHours(4) }))
          .profile,
      ).toMatchObject({ status: null, statusEmoji: family, statusUntil: inHours(4) });
      expect(
        (await updateProfile(db, clock, alice, { status: '  ', statusUntil: inHours(4) })).profile,
      ).toMatchObject({ status: null, statusEmoji: null, statusUntil: null });
    });
  });

  test('an end now, past, beyond a week or naming no instant is refused by name, and nothing is written', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = idOf(room, 'alice');
      await updateProfile(db, clock, alice, { status: 'Here' });
      for (const statusUntil of [
        START.toISOString(),
        inHours(-1),
        inHours(7 * 24 + 0.001),
        '2026-13-40T99:00:00Z',
      ]) {
        expect(
          await refusal(db, () => updateProfile(db, clock, alice, { status: 'Away', statusUntil })),
        ).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { fields: { statusUntil: 'ahead, and at most 168 hours' } },
        });
      }
      expect((await meOf(db, clock, alice, ANYONE)).profile).toMatchObject({
        status: 'Here',
        statusUntil: null,
      });
      // The week itself is allowed.
      expect(
        (await updateProfile(db, clock, alice, { status: 'Away', statusUntil: inHours(7 * 24) }))
          .profile.statusUntil,
      ).toBe(inHours(7 * 24));
    });
  });
});
