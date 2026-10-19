/**
 * A channel's pins through HTTP (#485, D-130): a change tells everyone watching the channel, after
 * the commit and on its topic; a change that was none, and a refusal, tell nobody.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, type PinList, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { channelTopic, NO_LOG, type EventBus } from '../../platform/events';
import { SESSION_COOKIE } from '../../platform/cookies';
import { issueSession } from '../../modules/auth/sessions';
import { aRoom } from '../../testing/rooms';
import { testDependencies } from '../../testing/doubles';
import { createApp } from './app';
import { deletePin, putPin } from './pins';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

describe('integration: who is told of a pin', () => {
  test('the channel, once for each change and never for one that was none or refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { outsiders: ['carol'] });
      const message = messageId(NOW);
      await db
        .insertInto('messages')
        .values({
          id: message,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: room.members['bob']?.userId ?? '',
          content: 'pin this',
        })
        .execute();
      const asked = async (userId: string): Promise<() => Request> => {
        const { token } = await issueSession(db, clock, userId, 30);
        return () =>
          new Request('https://purlay.test/', {
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          });
      };
      const alice = await asked(room.members['alice']?.userId ?? '');
      const carol = await asked(room.outsiders['carol']?.userId ?? '');
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

      await putPin(dependencies, alice(), message);
      await putPin(dependencies, alice(), message);
      const refused = await putPin(dependencies, carol(), message).then(
        () => 'taken',
        (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
      );
      await deletePin(dependencies, alice(), message);
      await deletePin(dependencies, alice(), message);

      expect(refused).toBe('NOT_A_CHANNEL_MEMBER');
      const frame: ServerFrame = {
        event: 'PINS_UPDATED',
        data: { channelId: room.channelId },
        ts: NOW.getTime(),
      };
      expect(told).toEqual([
        [channelTopic(room.channelId), frame],
        [channelTopic(room.channelId), frame],
      ]);
    });
  });
});

describe('integration: the routes', () => {
  test('PUT and DELETE answer 204 with nothing in them, and GET lists what is pinned', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const message = messageId(NOW);
      await db
        .insertInto('messages')
        .values({
          id: message,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: room.members['alice']?.userId ?? '',
          content: 'pin this',
        })
        .execute();
      const { token } = await issueSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const app = createApp(testDependencies({ database: db, clock }));
      const call = async (method: string, path: string): Promise<Response> =>
        await app.handle(
          new Request(`https://purlay.test${path}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          }),
        );
      const pins = async (): Promise<PinList> =>
        (await (await call('GET', `/api/channels/${room.channelId}/pins`)).json()) as PinList;

      const pinned = await call('PUT', `/api/messages/${message}/pin`);
      expect([pinned.status, await pinned.text()]).toEqual([204, '']);
      expect((await pins()).map((pin) => pin.message.id)).toEqual([message]);

      const unpinned = await call('DELETE', `/api/messages/${message}/pin`);
      expect([unpinned.status, await unpinned.text()]).toEqual([204, '']);
      expect(await pins()).toEqual([]);
    });
  });
});
