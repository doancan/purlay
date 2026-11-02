/**
 * Quiet hours (D-234) through real requests: set on the person's own route, read on their profile's
 * clock, and honoured where Deep Work is — a mention written during them is kept and counted, and held
 * back from interrupting (`suppressed_by_deep_work`), one written outside them is not.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type QuietHoursSetting } from '@purlay/types';
import { createApp } from './app';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock, type Clock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

/** NOW is Wednesday 2026-09-09, 12:00 UTC: 15:00 in Istanbul. */
const ISTANBUL_AFTERNOON = { from: 14 * 60, to: 16 * 60, days: [3] };
const ISTANBUL_EVENING = { from: 19 * 60, to: 9 * 60, days: [1, 2, 3, 4, 5] };

const caller =
  (db: Executor, clock: Clock = fixedClock(NOW)) =>
  async (method: string, path: string, as: SignedInUser, body?: unknown): Promise<Response> =>
    await createApp(testDependencies({ database: db, clock })).handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: as.cookie,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

const inIstanbul = async (db: Executor, person: SignedInUser): Promise<void> => {
  const call = caller(db);
  expect(
    (await call('PATCH', '/api/me/profile', person, { timeZone: 'Europe/Istanbul' })).status,
  ).toBe(200);
};

describe('integration: setting quiet hours', () => {
  test('none at first; kept and answered; cleared with null', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const person = await aSignedInUser(db, fixedClock(NOW), 'qh-set');
      const read = async (): Promise<QuietHoursSetting> =>
        (await (await call('GET', '/api/me/quiet-hours', person)).json()) as QuietHoursSetting;
      expect(await read()).toEqual({ quietHours: null, timeZone: null });
      await inIstanbul(db, person);
      const set = await call('PUT', '/api/me/quiet-hours', person, {
        quietHours: ISTANBUL_EVENING,
      });
      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({
        quietHours: ISTANBUL_EVENING,
        timeZone: 'Europe/Istanbul',
      });
      expect(await read()).toEqual({ quietHours: ISTANBUL_EVENING, timeZone: 'Europe/Istanbul' });
      expect((await call('PUT', '/api/me/quiet-hours', person, { quietHours: null })).status).toBe(
        200,
      );
      expect((await read()).quietHours).toBeNull();
    });
  });

  test('without a time zone on the profile, or with equal ends, it is refused by name; anything else is 400', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const person = await aSignedInUser(db, fixedClock(NOW), 'qh-refuse');
      const noZone = await call('PUT', '/api/me/quiet-hours', person, {
        quietHours: ISTANBUL_EVENING,
      });
      expect(noZone.status).toBe(400);
      expect(await noZone.json()).toMatchObject({
        error: { details: { fields: { quietHours: 'needs a time zone on your profile' } } },
      });
      await inIstanbul(db, person);
      const equal = await call('PUT', '/api/me/quiet-hours', person, {
        quietHours: { from: 600, to: 600, days: [1] },
      });
      expect(equal.status).toBe(400);
      for (const quietHours of [
        { ...ISTANBUL_EVENING, from: 1440 },
        { ...ISTANBUL_EVENING, days: [] },
      ]) {
        expect((await call('PUT', '/api/me/quiet-hours', person, { quietHours })).status).toBe(400);
      }
    });
  });
});

describe('integration: quiet hours hold back what interrupts', () => {
  const aMention = async (
    db: Executor,
    window: typeof ISTANBUL_AFTERNOON,
    deepWorkEnded = false,
  ): Promise<{ readonly suppressed: boolean; readonly kept: number }> => {
    const call = caller(db);
    const alice = await aSignedInUser(db, fixedClock(NOW), 'qh-alice');
    const bob = await aSignedInUser(db, fixedClock(NOW), 'qh-bob');
    const slug = aUniqueSlug('qh');
    const made = await call('POST', '/api/workspaces', alice, { name: slug, slug });
    const workspaceId = ((await made.json()) as { id: string }).id;
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
      .execute();
    const channel = await call('POST', `/api/workspaces/${workspaceId}/channels`, alice, {
      name: 'quiet',
    });
    const channelId = ((await channel.json()) as { id: string }).id;
    expect((await call('POST', `/api/channels/${channelId}/join`, bob)).status).toBe(200);
    if (deepWorkEnded) {
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() - 3_600_000) })
        .where('user_id', '=', bob.userId)
        .execute();
    }
    await inIstanbul(db, bob);
    expect((await call('PUT', '/api/me/quiet-hours', bob, { quietHours: window })).status).toBe(
      200,
    );

    const sent = await call('POST', `/api/channels/${channelId}/messages`, alice, {
      id: messageId(NOW),
      content: `@${bob.username} a question`,
    });
    expect(sent.ok).toBe(true);
    const rows = await db
      .selectFrom('notifications')
      .select('suppressed_by_deep_work')
      .where('user_id', '=', bob.userId)
      .execute();
    return { suppressed: rows.every((row) => row.suppressed_by_deep_work), kept: rows.length };
  };

  test('a mention inside the window is kept and held back', async () => {
    await withRollback(async (db) => {
      expect(await aMention(db, ISTANBUL_AFTERNOON)).toEqual({ suppressed: true, kept: 1 });
    });
  });

  test('Deep Work that has ended holds nothing back, quiet hours or not', async () => {
    await withRollback(async (db) => {
      // Ended an hour ago, on a person whose quiet hours are set but not now: the row is read for its
      // quiet hours, and the Deep Work on it must still be over.
      expect(await aMention(db, ISTANBUL_EVENING, true)).toEqual({ suppressed: false, kept: 1 });
    });
  });

  test('a mention outside it interrupts as ever', async () => {
    await withRollback(async (db) => {
      expect(await aMention(db, ISTANBUL_EVENING)).toEqual({ suppressed: false, kept: 1 });
    });
  });
});
