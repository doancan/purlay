/**
 * A version removed through HTTP (#82, D-135 §5): the channel is told, after the commit and on its
 * topic, so an open history drops the words; a refusal tells nobody.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { channelTopic, NO_LOG, type EventBus } from '../../platform/events';
import { SESSION_COOKIE } from '../../platform/cookies';
import { issueSession } from '../../modules/auth/sessions';
import { reviseMessage } from '../../modules/messages/edit';
import { sendMessage } from '../../modules/messages/messages';
import { aRoom } from '../../testing/rooms';
import { deleteVersion } from './versions';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

describe('integration: who is told of a version removed', () => {
  test('the channel, once, after the commit; a refusal tells nobody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('no people');
      const sent = await sendMessage(db, clock, alice.context, {
        id: messageId(NOW),
        content: 'token ghp_oops',
      });
      await reviseMessage(
        db,
        fixedClock(new Date(NOW.getTime() + 1000)),
        alice.userId,
        sent.message.id,
        'rotated',
      );
      const version = await db
        .selectFrom('message_versions')
        .select('id')
        .where('message_id', '=', sent.message.id)
        .executeTakeFirstOrThrow();
      const told: [string, ServerFrame][] = [];
      const bus: EventBus = {
        publish: (topic, frame) => {
          told.push([topic, frame]);
          return Promise.resolve();
        },
        subscribe: () => false,
        unsubscribe: () => undefined,
        forget: () => undefined,
      };
      const as = async (userId: string): Promise<Request> => {
        const { token } = await issueSession(db, clock, userId, 30);
        return new Request('https://purlay.test/', {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
        });
      };
      const dependencies = { database: db, clock, bus, log: NO_LOG };

      const refused = await deleteVersion(
        dependencies,
        await as(bob.userId),
        sent.message.id,
        version.id,
      ).then(
        () => 'removed',
        () => 'refused',
      );
      expect(refused).toBe('refused');
      expect(told).toEqual([]);

      await deleteVersion(dependencies, await as(alice.userId), sent.message.id, version.id);
      expect(told).toEqual([
        [
          channelTopic(room.channelId),
          {
            event: 'MESSAGE_VERSIONS_UPDATED',
            data: { channelId: room.channelId, messageId: sent.message.id },
            ts: NOW.getTime(),
          },
        ],
      ]);
    });
  });
});
