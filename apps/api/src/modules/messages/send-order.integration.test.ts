/**
 * The room is told after the commit, never before (D-35).
 *
 * A subscriber that receives a message and then finds it is not there — because the
 * transaction that wrote it rolled back after the announcement — has been lied to,
 * and nothing can take the frame back. So `send` publishes only once the commit has
 * returned. That is an order, and an order is only visible from outside the
 * transaction: inside the harness's rolled-back transaction everything is "visible",
 * so this file has a database of its own and reads from a second connection at the
 * moment of each publish — which sees a row only if it is committed (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { aChannel } from '../../testing/channels';
import { send } from './messages';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');

/** A bus that records, for each frame, whether its message was committed when it arrived. */
const aBusThatLooks = (): { bus: EventBus; sawCommitted: boolean[] } => {
  const sawCommitted: boolean[] = [];
  const bus: EventBus = {
    publish: async (_topic, frame: ServerFrame) => {
      if (frame.event !== 'MESSAGE_CREATED') return;
      // The pool, not the transaction: a different connection, so only a commit shows.
      const row = await cloned.db
        .selectFrom('messages')
        .select('id')
        .where('id', '=', frame.data.id)
        .executeTakeFirst();
      sawCommitted.push(row !== undefined);
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, sawCommitted };
};

describe('integration: a send is announced after it is committed', () => {
  test('the message can be read from another connection when the room is told', async () => {
    const channel = await aChannel(cloned.db);
    const { bus, sawCommitted } = aBusThatLooks();
    await send({ atomically: atomicallyOn(cloned.db), clock: fixedClock(NOW), bus }, channel, {
      id: messageId(NOW),
      content: 'hello',
    });
    expect(sawCommitted).toEqual([true]);
  });

  test('a send that rolls back is announced to nobody, and leaves no message', async () => {
    const channel = await aChannel(cloned.db);
    // The second write of a send is the channel's `last_message_at`; refuse it, as a
    // deadlock or a dropped connection would, after the message itself was inserted.
    await sql`create function refuse_channel_update() returns trigger language plpgsql as
      $$ begin raise exception 'refused by the test'; end $$`.execute(cloned.db);
    await sql`create trigger refuse_update before update on channels
      for each row execute function refuse_channel_update()`.execute(cloned.db);
    try {
      const { bus, sawCommitted } = aBusThatLooks();
      const id = messageId(NOW);
      const outcome = await send(
        { atomically: atomicallyOn(cloned.db), clock: fixedClock(NOW), bus },
        channel,
        { id, content: 'never stored' },
      ).then(
        () => 'sent',
        () => 'failed',
      );
      expect(outcome).toBe('failed');
      expect(sawCommitted).toEqual([]);
      const rows = await cloned.db
        .selectFrom('messages')
        .select('id')
        .where('id', '=', id)
        .execute();
      expect(rows).toEqual([]);
    } finally {
      await sql`drop trigger refuse_update on channels`.execute(cloned.db);
    }
  });
});
