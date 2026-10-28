import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { userTopic, type EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { sendMessage } from '../../modules/messages/messages';
import { hideMessage } from '../../modules/messages/hide';
import { removeMessage } from '../../modules/messages/delete';
import { hideMyMessage } from './hidden';

const clock = fixedClock(new Date('2026-10-28T12:00:00Z'));
let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
});

const setup = async (): Promise<{
  db: ClonedDatabase['db'];
  room: Room;
  alice: NonNullable<Room['members'][string]>;
  bob: NonNullable<Room['members'][string]>;
  message: string;
}> => {
  const db = cloned.db;
  const room = await aRoom(db, ['alice', 'bob']);
  const alice = room.members['alice'];
  const bob = room.members['bob'];
  if (alice === undefined || bob === undefined) throw new Error('missing people');
  const sent = await atomicallyOn(db)(
    async (tx) =>
      await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: `Hello @${bob.username}`,
      }),
  );
  await atomicallyOn(db)(
    async (tx) =>
      await sendMessage(tx, clock, alice.context, {
        id: messageId(clock.now()),
        content: 'Another unread message',
      }),
  );
  return { db, room, alice, bob, message: sent.message.id };
};

describe('integration: private deletion across sessions', () => {
  test('the HTTP write publishes only to the caller’s user topic', async () => {
    const { db, bob, message } = await setup();
    const session = await aSession(db, clock, bob.userId);
    const publications: { topic: string; frame: ServerFrame }[] = [];
    const bus: EventBus = {
      publish: (topic, frame): Promise<void> => {
        publications.push({ topic, frame });
        return Promise.resolve();
      },
      subscribe: () => false,
      unsubscribe: () => undefined,
      forget: () => undefined,
    };
    const response = await hideMyMessage(
      { database: db, clock, bus, auth: aTestAuth(db, { clock }) },
      new Request(`https://purlay.test/api/messages/${message}/hidden`, {
        method: 'PUT',
        headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
      }),
      message,
    );
    expect(response.hiddenForMe).toBe(true);
    expect(response.content).toBe('');
    expect(publications.length).toBeGreaterThan(0);
    expect(new Set(publications.map((item) => item.topic))).toEqual(
      new Set([userTopic(bob.userId)]),
    );
    expect(publications.some((item) => item.frame.event === 'MESSAGE_HIDDEN')).toBe(true);
    expect(publications.some((item) => item.frame.event === 'MESSAGE_REVISED')).toBe(false);
  });

  test('simultaneous private and global deletion retract one unread message exactly once', async () => {
    for (const globalFirst of [false, true]) {
      const { db, room, alice, bob, message } = await setup();
      const hide = async (): Promise<unknown> =>
        await atomicallyOn(db)(async (tx) => await hideMessage(tx, clock, bob.userId, message));
      const remove = async (): Promise<unknown> =>
        await atomicallyOn(db)(async (tx) => await removeMessage(tx, clock, alice.userId, message));
      await Promise.all(globalFirst ? [remove(), hide()] : [hide(), remove()]);
      const state = await db
        .selectFrom('channel_members')
        .select(['unread_count', 'unread_mention_count'])
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', bob.userId)
        .executeTakeFirstOrThrow();
      expect(state).toEqual({ unread_count: 1, unread_mention_count: 0 });
    }
  });
});
