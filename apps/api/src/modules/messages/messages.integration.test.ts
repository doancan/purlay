/**
 * What a send does to the channel row, and what a retry tells the room (D-88).
 *
 * Inside a transaction that is rolled back (D-46).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { isMessageIdShape, messageId, type ServerFrame } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireChannelById, type ChannelContext } from '../../platform/channels';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { send, sendMessage } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const later = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

/** A signed-in member of a workspace with one public channel. */
const aChannel = async (db: Executor): Promise<ChannelContext> => {
  const user = await aUserRow(db, 'send-user');
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Send', slug: aUniqueSlug('send') })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspace.id, user_id: user.userId, role: 'owner' })
    .execute();
  const channel = await db
    .insertInto('channels')
    .values({ workspace_id: workspace.id, name: 'general', type: 'public' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return await requireChannelById(db, user.userId, channel.id);
};

const lastMessageAt = async (db: Executor, channelId: string): Promise<string | null> => {
  const row = await db
    .selectFrom('channels')
    .select('last_message_at')
    .where('id', '=', channelId)
    .executeTakeFirstOrThrow();
  return row.last_message_at === null ? null : new Date(row.last_message_at).toISOString();
};

/** This transaction's own counters for `channels`, so the answer is this test's and not the database's history. */
const updateCounts = async (db: Executor): Promise<{ updated: number; hot: number }> => {
  const { rows } = await sql<{ updated: string; hot: string }>`
    select pg_stat_get_xact_tuples_updated('channels'::regclass) as updated,
           pg_stat_get_xact_tuples_hot_updated('channels'::regclass) as hot`.execute(db);
  return { updated: Number(rows[0]?.updated), hot: Number(rows[0]?.hot) };
};

const recordingBus = (failures = 0): { bus: EventBus; frames: ServerFrame[] } => {
  const frames: ServerFrame[] = [];
  let remaining = failures;
  const bus: EventBus = {
    publish: (_topic, frame) => {
      if (remaining > 0) {
        remaining -= 1;
        return Promise.reject(new Error('the bus is down'));
      }
      frames.push(frame);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, frames };
};

describe('integration: a send and the channel row', () => {
  test('last_message_at moves forward with each send and never backwards', async () => {
    await withRollback(async (db) => {
      const channel = await aChannel(db);
      const first = messageId(NOW);
      await sendMessage(db, fixedClock(later(10)), channel, { id: first, content: 'one' });
      expect(await lastMessageAt(db, channel.channelId)).toBe(later(10).toISOString());

      // A second sender whose clock is behind (another node, or a concurrent commit
      // that read its time earlier) must not pull the channel back in time.
      await sendMessage(db, fixedClock(later(4)), channel, {
        id: messageId(later(4)),
        content: 'two',
      });
      expect(await lastMessageAt(db, channel.channelId)).toBe(later(10).toISOString());

      await sendMessage(db, fixedClock(later(20)), channel, {
        id: messageId(later(20)),
        content: 'three',
      });
      expect(await lastMessageAt(db, channel.channelId)).toBe(later(20).toISOString());
    });
  });

  /**
   * `last_message_at` sat in `idx_channels_workspace`, so changing it could never
   * be a heap-only tuple update: every send wrote a new version of the row and a
   * new entry in each of the channel's indexes (0 of 2,000 were HOT). The counters
   * read here are the transaction's own, so the answer is this test's and not the
   * database's history. Kept under the number of row versions one page holds, since
   * an open transaction cannot prune its own versions.
   */
  test('a send updates the channel row without touching its indexes (HOT)', async () => {
    await withRollback(async (db) => {
      const channel = await aChannel(db);
      const started = await updateCounts(db);
      for (let n = 1; n <= 20; n += 1) {
        await sendMessage(db, fixedClock(later(n)), channel, {
          id: messageId(later(n)),
          content: `message ${String(n)}`,
        });
      }
      const finished = await updateCounts(db);
      expect(finished.updated - started.updated).toBe(20);
      expect(finished.hot - started.hot).toBe(20);
    });
  });

  test('a send that is not newer than the channel does not write the row at all', async () => {
    await withRollback(async (db) => {
      const channel = await aChannel(db);
      await sendMessage(db, fixedClock(later(10)), channel, {
        id: messageId(later(10)),
        content: 'newest',
      });
      const before = await updateCounts(db);
      await sendMessage(db, fixedClock(later(5)), channel, {
        id: messageId(later(5)),
        content: 'older clock',
      });
      expect((await updateCounts(db)).updated).toBe(before.updated);
    });
  });
});

describe('integration: a retried send', () => {
  /**
   * The decision (D-88): a retry announces the stored message again. A commit
   * followed by a failed publish makes the sender see an error and retry, and if the
   * retry stayed silent the room would never hear of a message that is in the
   * database. Clients de-duplicate by id (D-65), so the cost of the announcement
   * that was not needed is one frame that changes nothing.
   */
  test('announces the stored message again, once per retry, and writes nothing twice', async () => {
    await withRollback(async (db) => {
      const channel = await aChannel(db);
      const { bus, frames } = recordingBus();
      const dependencies = { atomically: atomicallyOn(db), clock: fixedClock(later(1)), bus };
      const id = messageId(later(1));

      const first = await send(dependencies, channel, { id, content: 'hello' });
      const retry = await send(dependencies, channel, { id, content: 'hello' });

      expect(retry).toEqual(first);
      expect(frames.map((frame) => frame.event)).toEqual(['MESSAGE_CREATED', 'MESSAGE_CREATED']);
      expect(
        frames.map((frame) => (frame.event === 'MESSAGE_CREATED' ? frame.data.id : '')),
      ).toEqual([id, id]);
      const rows = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', channel.channelId)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  test('a message committed but not announced is announced by the retry', async () => {
    await withRollback(async (db) => {
      const channel = await aChannel(db);
      const { bus, frames } = recordingBus(1);
      const dependencies = { atomically: atomicallyOn(db), clock: fixedClock(later(1)), bus };
      const id = messageId(later(1));

      const failed = await send(dependencies, channel, { id, content: 'hello' }).then(
        () => 'sent',
        (error: unknown) => String(error),
      );
      expect(failed).toContain('the bus is down');
      expect(frames).toHaveLength(0);

      await send(dependencies, channel, { id, content: 'hello' });
      expect(frames).toHaveLength(1);
    });
  });
});

describe('integration: the database and the contract agree on what a message id is', () => {
  /**
   * `messages_id_is_uuidv7` repeats the contract's `isMessageIdShape` in SQL so a writer
   * that skips the application check is still stopped (D-90). Two copies are drift
   * waiting, so they are compared: for each of these ids the table must accept it
   * exactly when the contract does.
   */
  const samples = [
    messageId(NOW),
    '0199155c-6200-4b7f-8c11-2a4d3f9e1b70', // version 4
    '0199155c-6200-7b7f-c811-2a4d3f9e1b70', // version 7, variant bits 11
    '0199155c-6200-6b7f-8c11-2a4d3f9e1b70', // version 6
    '0199155c-6200-7b7f-8c11-2a4d3f9e1b70', // version 7, variant 10
    '00000000-0000-0000-0000-000000000000',
    'ffffffff-ffff-ffff-ffff-ffffffffffff',
  ];

  for (const id of samples) {
    test(id, async () => {
      await withRollback(async (db) => {
        const channel = await aChannel(db);
        const outcome = await db
          .insertInto('messages')
          .values({
            id,
            workspace_id: channel.workspaceId,
            channel_id: channel.channelId,
            sender_id: channel.userId,
            content: 'x',
          })
          .execute()
          .then(
            () => 'accepted',
            () => 'refused',
          );
        expect(outcome).toBe(isMessageIdShape(id) ? 'accepted' : 'refused');
      });
    });
  }
});
