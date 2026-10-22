/**
 * Saved messages through HTTP (#484, D-128): each change tells the person's own devices, after the
 * commit, and nobody else.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { NO_LOG, userTopic, type EventBus } from '../../platform/events';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aTestAuth, aSession } from '../../testing/signed-in';
import { aRoom } from '../../testing/rooms';
import { deleteSaved, putSaved } from './saved';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

describe('integration: who is told', () => {
  test('the person’s own devices, after each change; nobody else', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const first = messageId(NOW);
      await db
        .insertInto('messages')
        .values({
          id: first,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: room.members['bob']?.userId ?? '',
          content: 'keep this',
        })
        .execute();
      const { token } = await aSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const topics: string[] = [];
      const bus: EventBus = {
        publish: (topic: string, frame: ServerFrame): Promise<void> => {
          if (frame.event === 'SAVED_UPDATED') topics.push(topic);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const request = (): Request =>
        new Request('https://purlay.test/', {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        });
      const dependencies = { auth: aTestAuth(db), database: db, clock, bus, log: NO_LOG };
      await putSaved(dependencies, request(), first, {});
      await deleteSaved(dependencies, request(), first);
      expect(topics).toEqual([
        userTopic(room.members['alice']?.userId ?? ''),
        userTopic(room.members['alice']?.userId ?? ''),
      ]);
    });
  });
});
