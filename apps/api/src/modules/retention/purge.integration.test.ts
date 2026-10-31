/**
 * The retention purge against the real database (D-27 §1, D-139 §1–§3, I-10): nothing where a workspace
 * keeps everything, and — the control — the same history gone where it keeps thirty days; the window's
 * edge to the millisecond; a thread across the window kept as a tombstone holding its younger replies,
 * and gone the night its last reply is old; the counters, the files' bytes and the files taken back;
 * one line on the trail per workspace, nothing purged or not.
 *
 * And a channel that keeps longer (D-225): forever, or a floor of its own, each beside a channel of the
 * same workspace that follows it; the longer window winning whichever of the two was set first; a thread
 * across the channel's window; batches that have to look past what a channel keeps; and nothing of one
 * workspace's setting reaching another's.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Transaction } from '@purlay/db';
import { messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, counters, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { sendMessage } from '../messages/messages';
import { removeMessage } from '../messages/delete';
import { PURGE_BATCH, purgeRetention, purgeWorkspace } from './purge';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T03:00:00.000Z');
const WINDOW_DAYS = 30;
const EDGE = new Date(NOW.getTime() - WINDOW_DAYS * DAY_MS);
const ago = (ms: number): Date => new Date(EDGE.getTime() - ms);
const after = (ms: number): Date => new Date(EDGE.getTime() + ms);

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

let tick = 0;
/** A message from `as` at `at`, a reply when a root is given. */
const post = async (
  db: Transaction,
  room: Room,
  as: string,
  at: Date,
  content: string,
  parentId?: string,
): Promise<string> => {
  tick += 1;
  const sent = await sendMessage(db, fixedClock(at), member(room, as).context, {
    id: messageId(new Date(at.getTime() + tick)),
    content,
    ...(parentId === undefined ? {} : { parentId }),
  });
  return sent.message.id;
};

const keep = async (db: Transaction, room: Room, days: number | null): Promise<void> => {
  await db
    .updateTable('workspaces')
    .set({ retention_days: days })
    .where('id', '=', room.workspaceId)
    .execute();
};

const deps = (db: Transaction, storage = aMemoryStore()): Parameters<typeof purgeRetention>[0] => ({
  database: db,
  clock: fixedClock(NOW),
  log: aRecordingLogger().log,
  storage,
});

const live = async (db: Transaction, ids: readonly string[]): Promise<string[]> =>
  (await db.selectFrom('messages').select(['id', 'deleted_at']).where('id', 'in', ids).execute())
    .filter((row) => row.deleted_at === null)
    .map((row) => row.id)
    .sort();

const present = async (db: Transaction, ids: readonly string[]): Promise<string[]> =>
  (await db.selectFrom('messages').select('id').where('id', 'in', ids).execute())
    .map((row) => row.id)
    .sort();

const trail = async (
  db: Transaction,
  workspaceId: string,
): Promise<{ action: string; metadata: unknown }[]> =>
  await db
    .selectFrom('audit_log')
    .select(['action', 'metadata'])
    .where('workspace_id', '=', workspaceId)
    .where('action', '=', 'retention.purged')
    .execute();

describe('integration: the retention purge', () => {
  test('a workspace that keeps everything loses nothing; the same history kept thirty days loses what is past them', async () => {
    await withRollback(async (db) => {
      const forever = await aRoom(db, ['ada', 'bob']);
      const month = await aRoom(db, ['cy', 'dee']);
      const old = [
        await post(db, forever, 'ada', ago(DAY_MS), 'old'),
        await post(db, month, 'cy', ago(DAY_MS), 'old'),
      ];
      await keep(db, month, WINDOW_DAYS);
      const done = await purgeRetention(deps(db));
      expect(done).toMatchObject({ workspaces: 1, deleted: 1, tombstoned: 0 });
      expect(await present(db, old)).toEqual(old.slice(0, 1));
      // The line on the trail is the workspace's that has a window, and only its.
      expect(await trail(db, forever.workspaceId)).toEqual([]);
      expect(await trail(db, month.workspaceId)).toEqual([
        {
          action: 'retention.purged',
          metadata: { days: '30', messages: '1', files: '0' },
        },
      ]);
    });
  });

  test('the window’s edge: a millisecond past it goes, at it and after it stays', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await keep(db, room, WINDOW_DAYS);
      const past = await post(db, room, 'ada', ago(1), 'past');
      const atEdge = await post(db, room, 'ada', EDGE, 'at the edge');
      const inside = await post(db, room, 'ada', after(1), 'inside');
      await purgeRetention(deps(db));
      expect(await present(db, [past, atEdge, inside])).toEqual([atEdge, inside].sort());
    });
  });

  test('a thread across the window: old replies go, the root holds the young one as a tombstone, and goes when that is old too', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await keep(db, room, WINDOW_DAYS);
      const root = await post(db, room, 'ada', ago(3 * DAY_MS), 'a question');
      const oldReply = await post(db, room, 'bob', ago(2 * DAY_MS), 'an old answer', root);
      const youngReply = await post(db, room, 'bob', after(DAY_MS), 'a young answer', root);
      const done = await purgeRetention(deps(db));
      expect(done).toMatchObject({ deleted: 1, tombstoned: 1 });
      expect(await present(db, [root, oldReply, youngReply])).toEqual([root, youngReply].sort());
      expect(await live(db, [root, youngReply])).toEqual([youngReply]);
      const summary = await db
        .selectFrom('messages')
        .select(['content', 'thread_reply_count', 'thread_last_reply_at'])
        .where('id', '=', root)
        .executeTakeFirstOrThrow();
      expect(summary).toEqual({
        content: '',
        thread_reply_count: 1,
        thread_last_reply_at: after(DAY_MS),
      });

      // A second night changes nothing: the tombstone already holds its thread.
      expect(await purgeRetention(deps(db))).toMatchObject({ deleted: 0, tombstoned: 0 });

      // Two days on, the young reply is old as well: it goes, and the root with it.
      await purgeWorkspace(
        { ...deps(db), clock: fixedClock(new Date(NOW.getTime() + 2 * DAY_MS)) },
        { id: room.workspaceId, retentionDays: WINDOW_DAYS },
      );
      expect(await present(db, [root, youngReply])).toEqual([]);
    });
  });

  test('what an old message added is taken back: the unread, the mention, the waiting notification', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const old = await post(db, room, 'ada', ago(DAY_MS), `@${member(room, 'bob').username} look`);
      await post(db, room, 'ada', after(DAY_MS), 'still here');
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 2,
        mentions: 1,
      });
      await keep(db, room, WINDOW_DAYS);
      await purgeRetention(deps(db));
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({
        unread: 1,
        mentions: 0,
      });
      expect(
        await db.selectFrom('notifications').select('id').where('message_id', '=', old).execute(),
      ).toEqual([]);
    });
  });

  test('an old message’s files: rows, bytes and objects gone; a young one’s stay', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const storage = aMemoryStore();
      const old = await post(db, room, 'ada', ago(DAY_MS), 'old');
      const young = await post(db, room, 'ada', after(DAY_MS), 'young');
      for (const [message, size] of [
        [old, 700],
        [young, 50],
      ] as const) {
        tick += 1;
        const id = messageId(new Date(NOW.getTime() + tick));
        const key = `w/${room.workspaceId}/${id}`;
        await storage.put(key, new Uint8Array([1]), 'application/octet-stream');
        await db
          .insertInto('attachments')
          .values({
            id,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            message_id: message,
            uploader_id: member(room, 'ada').userId,
            storage_key: key,
            file_name: 'a.bin',
            mime_type: 'application/octet-stream',
            size_bytes: String(size),
          })
          .execute();
      }
      await db
        .updateTable('workspaces')
        .set({ storage_used_bytes: '750', retention_days: WINDOW_DAYS })
        .where('id', '=', room.workspaceId)
        .execute();
      expect(await purgeRetention(deps(db, storage))).toMatchObject({
        attachments: 1,
        leftBehind: 0,
      });
      const { storage_used_bytes: used } = await db
        .selectFrom('workspaces')
        .select('storage_used_bytes')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      expect(used).toBe('50');
      expect(storage.keys()).toHaveLength(1);
      expect(storage.keys()[0]).toContain(room.workspaceId);
    });
  });

  test('more than a batch: every one goes, over as many transactions as it takes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await keep(db, room, WINDOW_DAYS);
      const count = PURGE_BATCH + 1;
      await db
        .insertInto('messages')
        .values(
          Array.from({ length: count }, (_, n) => {
            const at = ago(DAY_MS + n * 1000);
            return {
              id: messageId(at),
              channel_id: room.channelId,
              workspace_id: room.workspaceId,
              sender_id: member(room, 'ada').userId,
              content: `old ${String(n)}`,
              created_at: at,
            };
          }),
        )
        .execute();
      expect(await purgeRetention(deps(db))).toMatchObject({ deleted: count });
      const left = await db
        .selectFrom('messages')
        .select('id')
        .where('channel_id', '=', room.channelId)
        .execute();
      expect(left).toEqual([]);
    });
  });

  test('an old reply is taken back from the people it was counted for, as an old root is', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const root = await post(db, room, 'ada', ago(3 * DAY_MS), 'a question');
      await post(db, room, 'ada', ago(2 * DAY_MS), 'an old answer', root);
      await post(db, room, 'ada', after(DAY_MS), 'a young answer', root);
      const before = await counters(db, room, member(room, 'bob').userId);
      await keep(db, room, WINDOW_DAYS);
      await purgeRetention(deps(db));
      // The old reply and the root's words went; the young reply is still unread.
      const left = await counters(db, room, member(room, 'bob').userId);
      expect(before.unread - left.unread).toBe(2);
    });
  });

  test('a message deleted before the purge is not taken back again', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const old = await post(db, room, 'ada', ago(DAY_MS), 'old');
      await post(db, room, 'ada', after(DAY_MS), 'young');
      await removeMessage(db, fixedClock(NOW), member(room, 'ada').userId, old);
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({ unread: 1 });
      await keep(db, room, WINDOW_DAYS);
      expect(await purgeRetention(deps(db))).toMatchObject({ deleted: 1, cleared: 0 });
      expect(await counters(db, room, member(room, 'bob').userId)).toMatchObject({ unread: 1 });
    });
  });

  test('a night that purged nothing still says it ran, with nothing in it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await post(db, room, 'ada', after(DAY_MS), 'young');
      await keep(db, room, WINDOW_DAYS);
      expect(await purgeRetention(deps(db))).toMatchObject({ workspaces: 1, deleted: 0 });
      expect(await trail(db, room.workspaceId)).toEqual([
        { action: 'retention.purged', metadata: { days: '30', messages: '0', files: '0' } },
      ]);
    });
  });

  test('a reply exactly as old as the window stays; one a moment older goes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const root = await post(db, room, 'ada', ago(DAY_MS), 'a question');
      const past = await post(db, room, 'bob', ago(1), 'past', root);
      const atEdge = await post(db, room, 'bob', EDGE, 'at the edge', root);
      await keep(db, room, WINDOW_DAYS);
      await purgeRetention(deps(db));
      expect(await present(db, [past, atEdge])).toEqual([atEdge]);
    });
  });

  test('a resolved thread the purge empties is no longer counted answered (I-8)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      // A root inside the window over a reply older than it: written so by an import, say. The reply
      // goes and the root stays, with nothing in its thread.
      const root = await post(db, room, 'ada', after(DAY_MS), 'a question');
      tick += 1;
      const replyAt = ago(DAY_MS);
      await db
        .insertInto('messages')
        .values({
          id: messageId(replyAt),
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          sender_id: member(room, 'bob').userId,
          content: 'an answer',
          parent_id: root,
          created_at: replyAt,
        })
        .execute();
      await db
        .updateTable('messages')
        .set({
          thread_reply_count: 1,
          resolved_at: NOW,
          resolved_by: member(room, 'ada').userId,
        })
        .where('id', '=', root)
        .execute();
      await keep(db, room, WINDOW_DAYS);
      await purgeRetention(deps(db));
      expect(
        await db
          .selectFrom('messages')
          .select(['thread_reply_count', 'resolved_at', 'resolved_by'])
          .where('id', '=', root)
          .executeTakeFirstOrThrow(),
      ).toEqual({ thread_reply_count: 0, resolved_at: null, resolved_by: null });
    });
  });

  test('an old event nobody wrote goes too, and is taken back from everybody it was counted for', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const at = ago(DAY_MS);
      await db
        .insertInto('messages')
        .values({
          id: messageId(at),
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
          sender_id: null,
          message_type: 'system_event',
          content: 'a push',
          created_at: at,
        })
        .execute();
      await db
        .updateTable('channel_members')
        .set({ unread_count: 1 })
        .where('channel_id', '=', room.channelId)
        .execute();
      await keep(db, room, WINDOW_DAYS);
      expect(await purgeRetention(deps(db))).toMatchObject({ deleted: 1, cleared: 1 });
      for (const name of ['ada', 'bob']) {
        expect(await counters(db, room, member(room, name).userId)).toMatchObject({ unread: 0 });
      }
    });
  });

  test('a file the store will not delete fails the run, and the trail says it was left', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const storage = aMemoryStore();
      const old = await post(db, room, 'ada', ago(DAY_MS), 'old');
      tick += 1;
      const id = messageId(new Date(NOW.getTime() + tick));
      await db
        .insertInto('attachments')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: old,
          uploader_id: member(room, 'ada').userId,
          storage_key: `w/${room.workspaceId}/${id}`,
          file_name: 'a.bin',
          mime_type: 'application/octet-stream',
          size_bytes: '1',
        })
        .execute();
      await keep(db, room, WINDOW_DAYS);
      storage.failing('delete', new Error('the store is down'));
      const failure = await purgeRetention(deps(db, storage)).then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(failure)).toContain('could not delete');
      expect(await trail(db, room.workspaceId)).toEqual([
        {
          action: 'retention.purged',
          metadata: { days: '30', messages: '1', files: '1', filesLeft: '1' },
        },
      ]);
    });
  });
});

/** A second channel of the room's workspace, and nobody in it: messages are written straight in. */
const anotherChannel = async (db: Transaction, room: Room, name: string): Promise<string> =>
  (
    await db
      .insertInto('channels')
      .values({ workspace_id: room.workspaceId, name, type: 'public' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;

/** How long a channel keeps, as an owner sets it: forever, a floor of days, or the workspace's. */
const channelKeeps = async (
  db: Transaction,
  channelId: string,
  keeps: 'forever' | number | null,
): Promise<void> => {
  await db
    .updateTable('channels')
    .set({
      retain_forever: keeps === 'forever',
      min_retention_days: typeof keeps === 'number' ? keeps : null,
    })
    .where('id', '=', channelId)
    .execute();
};

/** A message written straight into a channel at `at`, as an import would; a reply under `parentId`. */
const written = async (
  db: Transaction,
  room: Room,
  channelId: string,
  at: Date,
  parentId?: string,
): Promise<string> => {
  tick += 1;
  const id = messageId(new Date(at.getTime() + tick));
  await db
    .insertInto('messages')
    .values({
      id,
      channel_id: channelId,
      workspace_id: room.workspaceId,
      sender_id: member(room, 'ada').userId,
      content: 'words',
      created_at: at,
      ...(parentId === undefined ? {} : { parent_id: parentId }),
    })
    .execute();
  if (parentId !== undefined) {
    await db
      .updateTable('messages')
      .set((eb) => ({ thread_reply_count: eb('thread_reply_count', '+', 1) }))
      .where('id', '=', parentId)
      .execute();
  }
  return id;
};

const daysAgo = (days: number, ms = 0): Date => new Date(NOW.getTime() - days * DAY_MS - ms);

/** `count` old messages in a channel, a second apart, from `days` ago backwards. */
const backlog = (
  room: Room,
  channelId: string,
  count: number,
  days: number,
): {
  id: string;
  channel_id: string;
  workspace_id: string;
  sender_id: string;
  content: string;
  created_at: Date;
}[] =>
  Array.from({ length: count }, (_, n) => {
    const at = daysAgo(days, n * 1000);
    return {
      id: messageId(at),
      channel_id: channelId,
      workspace_id: room.workspaceId,
      sender_id: member(room, 'ada').userId,
      content: `old ${String(n)}`,
      created_at: at,
    };
  });

describe('integration: a channel that keeps its history longer (D-225)', () => {
  test('a channel kept forever loses nothing; the channel beside it follows the workspace', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const decisions = await anotherChannel(db, room, 'decisions');
      await keep(db, room, WINDOW_DAYS);
      await channelKeeps(db, decisions, 'forever');
      const kept = [
        await written(db, room, decisions, daysAgo(400)),
        await written(db, room, decisions, daysAgo(31)),
      ];
      const gone = await written(db, room, room.channelId, daysAgo(31));

      expect(await purgeRetention(deps(db))).toMatchObject({ workspaces: 1, deleted: 1 });
      expect(await present(db, [...kept, gone])).toEqual([...kept].sort());
      // One line on the trail, with the workspace's window in it, as before (D-139 §3).
      expect(await trail(db, room.workspaceId)).toEqual([
        { action: 'retention.purged', metadata: { days: '30', messages: '1', files: '0' } },
      ]);
    });
  });

  test('a floor of ninety days: what is inside it stays, to the millisecond, and what is past it goes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await keep(db, room, WINDOW_DAYS);
      await channelKeeps(db, room.channelId, 90);
      const inside = await written(db, room, room.channelId, daysAgo(60));
      const atEdge = await written(db, room, room.channelId, daysAgo(90));
      const past = await written(db, room, room.channelId, daysAgo(90, 1));
      await purgeRetention(deps(db));
      expect(await present(db, [inside, atEdge, past])).toEqual([inside, atEdge].sort());
    });
  });

  test('the longer window wins whichever changed last: a workspace lengthened past the floor, or keeping everything', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await channelKeeps(db, room.channelId, 90);
      const twoHundred = await written(db, room, room.channelId, daysAgo(200));
      const fourHundred = await written(db, room, room.channelId, daysAgo(400));

      // The workspace keeps a year now: the channel's ninety days are shorter, and do not shorten it.
      await keep(db, room, 365);
      await purgeRetention(deps(db));
      expect(await present(db, [twoHundred, fourHundred])).toEqual([twoHundred]);

      // The workspace keeps everything: so does every channel in it, whatever its floor says.
      await keep(db, room, null);
      expect(await purgeRetention(deps(db))).toMatchObject({ workspaces: 0, deleted: 0 });
      expect(await present(db, [twoHundred])).toEqual([twoHundred]);

      // Back to thirty days: the floor is the longer window again, and the message is past it.
      await keep(db, room, WINDOW_DAYS);
      await purgeRetention(deps(db));
      expect(await present(db, [twoHundred])).toEqual([]);
    });
  });

  test('a thread across a channel’s floor: the old reply goes, the root holds the young one as a tombstone', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await keep(db, room, WINDOW_DAYS);
      await channelKeeps(db, room.channelId, 90);
      const root = await written(db, room, room.channelId, daysAgo(100));
      const oldReply = await written(db, room, room.channelId, daysAgo(95), root);
      // Past the workspace's thirty days, inside the channel's ninety.
      const youngReply = await written(db, room, room.channelId, daysAgo(60), root);

      expect(await purgeRetention(deps(db))).toMatchObject({ deleted: 1, tombstoned: 1 });
      expect(await present(db, [root, oldReply, youngReply])).toEqual([root, youngReply].sort());
      expect(await live(db, [root, youngReply])).toEqual([youngReply]);
      expect(
        await db
          .selectFrom('messages')
          .select('thread_reply_count')
          .where('id', '=', root)
          .executeTakeFirstOrThrow(),
      ).toEqual({ thread_reply_count: 1 });
    });
  });

  test('what a kept channel holds is not taken back: its unread count and its files’ bytes stay', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const storage = aMemoryStore();
      const old = await post(db, room, 'ada', ago(DAY_MS), 'old, and kept');
      tick += 1;
      const id = messageId(new Date(NOW.getTime() + tick));
      const key = `w/${room.workspaceId}/${id}`;
      await storage.put(key, new Uint8Array([1]), 'application/octet-stream');
      await db
        .insertInto('attachments')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: old,
          uploader_id: member(room, 'ada').userId,
          storage_key: key,
          file_name: 'a.bin',
          mime_type: 'application/octet-stream',
          size_bytes: '700',
        })
        .execute();
      await db
        .updateTable('workspaces')
        .set({ storage_used_bytes: '700', retention_days: WINDOW_DAYS })
        .where('id', '=', room.workspaceId)
        .execute();
      await channelKeeps(db, room.channelId, 'forever');
      const before = await counters(db, room, member(room, 'bob').userId);

      expect(await purgeRetention(deps(db, storage))).toMatchObject({
        deleted: 0,
        attachments: 0,
      });
      expect(await counters(db, room, member(room, 'bob').userId)).toEqual(before);
      const { storage_used_bytes: used } = await db
        .selectFrom('workspaces')
        .select('storage_used_bytes')
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      expect(used).toBe('700');
      expect(storage.keys()).toEqual([key]);
    });
  });

  test('more than a batch kept, older than more than a batch that goes: every one of those goes', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      const decisions = await anotherChannel(db, room, 'decisions');
      await keep(db, room, WINDOW_DAYS);
      await channelKeeps(db, decisions, 'forever');
      // The kept are the oldest, so a read that limited before it looked at the channel would find a
      // whole batch of them, and nothing to purge.
      await db
        .insertInto('messages')
        .values(backlog(room, decisions, PURGE_BATCH + 1, 300))
        .execute();
      await db
        .insertInto('messages')
        .values(backlog(room, room.channelId, PURGE_BATCH + 1, 100))
        .execute();

      expect(await purgeRetention(deps(db))).toMatchObject({ deleted: PURGE_BATCH + 1 });
      const left = async (channelId: string): Promise<number> =>
        (await db.selectFrom('messages').select('id').where('channel_id', '=', channelId).execute())
          .length;
      expect(await left(room.channelId)).toBe(0);
      expect(await left(decisions)).toBe(PURGE_BATCH + 1);
    });
  });

  test('an archived channel keeps its setting, and the purge still applies it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ada', 'bob']);
      await keep(db, room, WINDOW_DAYS);
      await channelKeeps(db, room.channelId, 'forever');
      await db
        .updateTable('channels')
        .set({ deleted_at: NOW })
        .where('id', '=', room.channelId)
        .execute();
      const old = await written(db, room, room.channelId, daysAgo(400));
      await purgeRetention(deps(db));
      expect(await present(db, [old])).toEqual([old]);
    });
  });

  test('one workspace’s channel setting reaches no other workspace', async () => {
    await withRollback(async (db) => {
      const keeping = await aRoom(db, ['ada', 'bob']);
      const following = await aRoom(db, ['ada', 'bob']);
      for (const room of [keeping, following]) await keep(db, room, WINDOW_DAYS);
      await channelKeeps(db, keeping.channelId, 'forever');
      const kept = await written(db, keeping, keeping.channelId, daysAgo(100));
      const gone = await written(db, following, following.channelId, daysAgo(100));

      // Each workspace by itself, as the run takes them: neither's purge reaches the other.
      await purgeWorkspace(deps(db), { id: following.workspaceId, retentionDays: WINDOW_DAYS });
      await purgeWorkspace(deps(db), { id: keeping.workspaceId, retentionDays: WINDOW_DAYS });
      expect(await present(db, [kept, gone])).toEqual([kept]);
    });
  });
});
