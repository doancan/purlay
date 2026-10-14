/**
 * `PATCH /api/me/profile` through the HTTP surface (#488, D-131): the caller's own, answered with the
 * profile, refused for what the contract refuses, and heard by everyone who shares a workspace with
 * them — after the commit, and only on a change.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { PROFILE_TITLE_MAX, type Profile, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { issueSession } from '../../modules/auth/sessions';
import { testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { createApp } from './app';
import { updateMyProfile } from './profile';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));

describe('integration: PATCH /api/me/profile', () => {
  test('answers the profile, and everyone in the workspace hears it, after the commit, once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice']?.userId ?? '';
      const bob = room.members['bob']?.userId ?? '';
      const { token } = await issueSession(db, clock, alice, 30);
      const told: string[] = [];
      const bus: EventBus = {
        publish: (topic: string, frame: ServerFrame): Promise<void> => {
          if (frame.event === 'WORKSPACE_UPDATED') told.push(topic);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const dependencies = { database: db, clock, bus, log: NO_LOG };
      const request = (): Request =>
        new Request('https://purlay.test/api/me/profile', {
          method: 'PATCH',
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        });
      const patch = async (body: unknown): Promise<Profile> =>
        await updateMyProfile(dependencies, request(), body);

      expect(await patch({ title: 'Engineer', timeZone: 'America/New_York' })).toEqual({
        title: 'Engineer',
        timeZone: 'America/New_York',
        status: null,
      });
      expect(told.sort()).toEqual([userTopic(alice), userTopic(bob)].sort());

      told.splice(0);
      await patch({ title: 'Engineer' });
      expect(told).toEqual([]);
    });
  });

  test('refuses what the contract refuses, and a caller with no session', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const { token } = await issueSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const patch = async (body: unknown, cookie = true): Promise<number> =>
        (
          await app.handle(
            new Request('https://purlay.test/api/me/profile', {
              method: 'PATCH',
              headers: {
                ...(cookie ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
            }),
          )
        ).status;

      expect(await patch({ title: 'x'.repeat(PROFILE_TITLE_MAX) })).toBe(200);
      expect(await patch({ title: 'x'.repeat(PROFILE_TITLE_MAX + 1) })).toBe(400);
      expect(await patch({ title: 'line\nbreak' })).toBe(400);
      expect(await patch({ status: '' })).toBe(400);
      expect(await patch({ timeZone: 'Not a zone' })).toBe(400);
      expect(await patch({ timeZone: 'Atlantis/Lost' })).toBe(400);
      expect(await patch({ nickname: 'x' })).toBe(400);
      expect(await patch({ title: 'Lead' }, false)).toBe(401);
    });
  });
});
