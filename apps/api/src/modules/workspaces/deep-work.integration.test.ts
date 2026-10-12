/**
 * Deep Work (D-15, D-108): started until an instant within the bound, ended by the person or by the
 * clock, and — while it lasts — every notification for the person written as suppressed, nothing lost.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { DEEP_WORK_MAX_HOURS, messageId } from '@purlay/types';
import { fixedClock, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { sendMessage } from '../messages/messages';
import { setResolved } from '../messages/threads';
import { NO_LOG, type EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { setDeepWork } from './deep-work';
import { membershipsOf } from './workspaces';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const at = (minutes: number): Date => new Date(NOW.getTime() + minutes * 60_000);
let tick = 0;

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const start = async (
  db: Executor,
  room: Room,
  name: string,
  until: Date,
): Promise<string | null> => {
  const context = await requireWorkspaceMembership(db, member(room, name).userId, room.workspaceId);
  return (await setDeepWork(db, clock, context, { active: true, until: until.toISOString() }))
    .until;
};

const name = async (
  db: Executor,
  room: Room,
  by: string,
  whom: string,
  when: Clock,
): Promise<string> =>
  (
    await sendMessage(db, when, member(room, by).context, {
      id: messageId(new Date(when.now().getTime() + (tick += 1))),
      content: `@${member(room, whom).username} look`,
    })
  ).message.id;

const suppressed = async (db: Executor, userId: string, id: string): Promise<boolean | undefined> =>
  (
    await db
      .selectFrom('notifications')
      .select('suppressed_by_deep_work')
      .where('user_id', '=', userId)
      .where('message_id', '=', id)
      .executeTakeFirst()
  )?.suppressed_by_deep_work;

const noBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const refusalOf = async (attempt: Promise<unknown>): Promise<AppError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

describe('integration: starting and ending it', () => {
  test('until an instant: the membership says until when, and ending it says null', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      expect(await start(db, room, 'alice', at(60))).toBe(at(60).toISOString());
      const alice = member(room, 'alice').userId;
      const mine = await membershipsOf(db, clock, alice);
      expect(mine[0]?.deepWorkUntil).toBe(at(60).toISOString());
      const context = await requireWorkspaceMembership(db, alice, room.workspaceId);
      expect((await setDeepWork(db, clock, context, { active: false })).until).toBeNull();
      expect((await membershipsOf(db, clock, alice))[0]?.deepWorkUntil).toBeNull();
    });
  });

  test('it ends by itself: past its instant the membership says null, with nothing run to end it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      await start(db, room, 'alice', at(30));
      const later = fixedClock(at(31));
      expect(
        (await membershipsOf(db, later, member(room, 'alice').userId))[0]?.deepWorkUntil,
      ).toBeNull();
    });
  });

  test('until must be ahead, and no further than the bound', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      for (const until of [at(0), at(-5), at(DEEP_WORK_MAX_HOURS * 60 + 1)]) {
        const refusal = await refusalOf(start(db, room, 'alice', until));
        expect(refusal.body).toMatchObject({
          code: 'VALIDATION_FAILED',
          details: { fields: { until: expect.any(String) as unknown } },
        });
      }
      expect(await start(db, room, 'alice', at(DEEP_WORK_MAX_HOURS * 60))).not.toBeNull();
    });
  });
});

describe('integration: while it lasts', () => {
  test('the notification is written, suppressed, and still counted; after it, not suppressed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await start(db, room, 'bob', at(60));
      const bob = member(room, 'bob').userId;
      const during = await name(db, room, 'alice', 'bob', clock);
      expect(await suppressed(db, bob, during)).toBe(true);
      expect(await counters(db, room, bob)).toMatchObject({ unread: 1, mentions: 1 });
      const after = await name(db, room, 'alice', 'bob', fixedClock(at(61)));
      expect(await suppressed(db, bob, after)).toBe(false);
    });
  });

  test('a resolution of their question is written suppressed too', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await sendMessage(db, clock, member(room, 'bob').context, {
        id: messageId(new Date(NOW.getTime() + (tick += 1))),
        content: 'a question',
      });
      await sendMessage(db, clock, member(room, 'alice').context, {
        id: messageId(new Date(NOW.getTime() + (tick += 1))),
        content: 'an answer',
        parentId: root.message.id,
      });
      await start(db, room, 'bob', at(60));
      await setResolved(
        { atomically: atomicallyOn(db), clock, bus: noBus, log: NO_LOG },
        member(room, 'alice').userId,
        root.message.id,
        true,
      );
      expect(await suppressed(db, member(room, 'bob').userId, root.message.id)).toBe(true);
    });
  });

  test('it is the person’s alone: somebody else in the room is not suppressed', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await start(db, room, 'bob', at(60));
      const sent = await name(db, room, 'alice', 'carol', clock);
      expect(await suppressed(db, member(room, 'carol').userId, sent)).toBe(false);
    });
  });
});
