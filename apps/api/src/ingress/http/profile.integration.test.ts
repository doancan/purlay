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
import { aTestAuth, aSession } from '../../testing/signed-in';
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
      const { token } = await aSession(db, clock, alice, 30);
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
      const dependencies = { auth: aTestAuth(db), database: db, clock, bus, log: NO_LOG };
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
      const { token } = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
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

describe('integration: the name, where it is the person’s own (D-235)', () => {
  const app = (db: Parameters<typeof aTestAuth>[0]): ReturnType<typeof createApp> =>
    createApp(testDependencies({ database: db, clock }));
  const asOwner = async (
    db: Parameters<typeof aTestAuth>[0],
    userId: string,
  ): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> => {
    const { token } = await aSession(db, clock, userId, 30);
    return async (method, path, body) =>
      await app(db).handle(
        new Request(`https://purlay.test${path}`, {
          method,
          headers: {
            cookie: `${SESSION_COOKIE}=${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
  };

  test('an account a link made sets its name: /api/me says it is its own, and shows the new one', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const call = await asOwner(db, room.members['alice']?.userId ?? '');
      const me = async (): Promise<{ user: { displayName: string }; nameFromGitHub: boolean }> =>
        (await (await call('GET', '/api/me')).json()) as {
          user: { displayName: string };
          nameFromGitHub: boolean;
        };
      expect((await me()).nameFromGitHub).toBe(false);
      expect(
        (await call('PATCH', '/api/me/profile', { displayName: '  Ada Lovelace ' })).status,
      ).toBe(200);
      expect((await me()).user.displayName).toBe('Ada Lovelace');
      // Nothing that cannot be shown, and never nothing at all.
      for (const displayName of ['', 'Ada‮Lovelace', 'a'.repeat(129)]) {
        expect((await call('PATCH', '/api/me/profile', { displayName })).status).toBe(400);
      }
    });
  });

  test('an account GitHub made keeps GitHub’s name: refused on displayName, unless it is the same', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['grace']);
      const userId = room.members['grace']?.userId ?? '';
      await db
        .updateTable('users')
        .set({ github_id: '583231', github_connected_at: null })
        .where('id', '=', userId)
        .execute();
      const call = await asOwner(db, userId);
      const me = (await (await call('GET', '/api/me')).json()) as {
        user: { displayName: string };
        nameFromGitHub: boolean;
      };
      expect(me.nameFromGitHub).toBe(true);
      const refused = await call('PATCH', '/api/me/profile', { displayName: 'Somebody else' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: { details: { fields: { displayName: 'comes from GitHub' } } },
      });
      // A client that sends the name it was shown changes nothing, and is not refused for it.
      expect(
        (await call('PATCH', '/api/me/profile', { displayName: me.user.displayName, title: 'CTO' }))
          .status,
      ).toBe(200);
      // Connected to GitHub later, the account's name is its own again.
      await db
        .updateTable('users')
        .set({ github_connected_at: clock.now() })
        .where('id', '=', userId)
        .execute();
      expect((await call('PATCH', '/api/me/profile', { displayName: 'Grace H.' })).status).toBe(
        200,
      );
    });
  });
});
