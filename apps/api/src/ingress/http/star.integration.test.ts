/**
 * Starring a channel through HTTP (#489, D-132): the member's own, on their membership row; carried
 * on the channel as `starred` for them and nobody else; refused as the channel is for a stranger
 * and for somebody who can see it without being in it; and heard by their own tabs only, and only
 * on a change.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import type { Channel, ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { issueSession } from '../../modules/auth/sessions';
import { testDependencies } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { createApp } from './app';
import { starChannel } from './star';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));

describe('integration: a star', () => {
  test('is the member’s own: theirs is starred, nobody else’s', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { outsiders: ['carol'] });
      const session = async (name: string): Promise<string> =>
        (
          await issueSession(
            db,
            clock,
            room.members[name]?.userId ?? room.outsiders[name]?.userId ?? '',
            30,
          )
        ).token;
      const app = createApp(testDependencies({ database: db, clock }));
      const call = async (method: string, path: string, token: string): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          }),
        );
      const starredFor = async (token: string): Promise<boolean | undefined> =>
        (
          (await (
            await call('GET', `/api/workspaces/${room.workspaceId}/channels`, token)
          ).json()) as Channel[]
        ).find((c) => c.id === room.channelId)?.starred;
      const alice = await session('alice');
      const bob = await session('bob');

      const put = await call('PUT', `/api/channels/${room.channelId}/star`, alice);
      expect([put.status, await put.text()]).toEqual([204, '']);
      expect(await starredFor(alice)).toBe(true);
      expect(await starredFor(bob)).toBe(false);
      // Somebody who sees the channel without being in it has no star of it.
      expect(await starredFor(await session('carol'))).toBe(false);

      expect((await call('PUT', `/api/channels/${room.channelId}/star`, alice)).status).toBe(204);
      expect(await starredFor(alice)).toBe(true);

      expect((await call('DELETE', `/api/channels/${room.channelId}/star`, alice)).status).toBe(
        204,
      );
      expect(await starredFor(alice)).toBe(false);
    });
  });

  test('somebody who can see a public channel without being in it cannot star it, and is told 404', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['carol'] });
      const { token } = await issueSession(db, clock, room.outsiders['carol']?.userId ?? '', 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const response = await app.handle(
        new Request(`https://purlay.test/api/channels/${room.channelId}/star`, {
          method: 'PUT',
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        }),
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: 'CHANNEL_NOT_FOUND' } });
    });
  });

  test('the member’s own tabs are told, once for each change and never for one that was none', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice']?.userId ?? '';
      const { token } = await issueSession(db, clock, alice, 30);
      const told: [string, ServerFrame][] = [];
      const bus: EventBus = {
        publish: (topic: string, frame: ServerFrame): Promise<void> => {
          told.push([topic, frame]);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const dependencies = { database: db, clock, bus, log: NO_LOG };
      const request = (): Request =>
        new Request('https://purlay.test/', { headers: { cookie: `${SESSION_COOKIE}=${token}` } });

      await starChannel(dependencies, request(), room.channelId, true);
      await starChannel(dependencies, request(), room.channelId, true);
      await starChannel(dependencies, request(), room.channelId, false);
      await starChannel(dependencies, request(), room.channelId, false);

      const frame: ServerFrame = {
        event: 'CHANNELS_UPDATED',
        data: { workspaceId: room.workspaceId },
        ts: clock.now().getTime(),
      };
      expect(told).toEqual([
        [userTopic(alice), frame],
        [userTopic(alice), frame],
      ]);
    });
  });
});
