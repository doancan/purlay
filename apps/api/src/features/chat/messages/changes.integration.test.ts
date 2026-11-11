/**
 * The two ways the changes of a channel are read (#1018): by the ids the two indexes hold when there are few, and
 * as the whole channel when there are many. The first exists to answer an empty poll without a scan, and it is only
 * allowed to if it answers every poll as the scan does — the same rows, in the same order, to the byte.
 *
 * So each case here is asked both ways and the answers are held against each other; the cases are the ones a
 * shortcut could get wrong: nothing new, a few changes, a message hidden by the caller, a deletion, a `since`
 * from long ago, a reply to a thread, a walk in pages.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { aRoom, type Room } from '../../../testing/rooms';
import type { ChannelContext } from '../channels/guard';
import { changedRows, IDS_READ_MAX, type ChangedRows, type ChangeWindow } from './changes';
import { sendMessage } from './messages';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms: number): Date => new Date(Date.now() - ms);
/** Later than anything a test writes, as a walk that began after it. */
const asOfAfterEverything = (): Date => new Date(Date.now() + DAY);

let tick = 0;
const anId = (at: Date): string => messageId(new Date(at.getTime() + (tick += 1)));

const withRoom = async (body: (db: Executor, room: Room) => Promise<void>): Promise<void> => {
  await withRollback(async (db) => {
    await body(db, await aRoom(db, ['alice', 'bob']));
  });
};

const contextOf = (room: Room, name: string): ChannelContext => {
  const member = room.members[name];
  if (member === undefined) throw new Error(`no member ${name}`);
  return member.context;
};

interface MessageInsert {
  readonly id: string;
  readonly workspace_id: string;
  readonly channel_id: string;
  readonly sender_id: string;
  readonly content: string;
  readonly created_at: Date;
  readonly changed_at: Date;
}

interface Answer {
  readonly read: 'ids' | 'scan';
  readonly ids: string[];
  readonly rows: ChangedRows['rows'];
}

const rowAt = (
  room: Room,
  changedAt: Date,
  id: string = anId(changedAt),
  content = 'text',
): MessageInsert => ({
  id,
  workspace_id: room.workspaceId,
  channel_id: room.channelId,
  sender_id: contextOf(room, 'alice').userId,
  content,
  created_at: changedAt,
  changed_at: changedAt,
});

const insertAt = async (
  db: Executor,
  room: Room,
  changedAt: Date,
  id?: string,
): Promise<string> => {
  const row = rowAt(room, changedAt, id);
  await db.insertInto('messages').values(row).execute();
  return row.id;
};

const hide = async (db: Executor, room: Room, by: string, id: string, at: Date): Promise<void> => {
  await db
    .insertInto('hidden_messages')
    .values({
      user_id: contextOf(room, by).userId,
      message_id: id,
      channel_id: room.channelId,
      workspace_id: room.workspaceId,
      hidden_at: at,
    })
    .execute();
};

const windowFrom = (from: Date, extra: Partial<ChangeWindow> = {}): ChangeWindow => ({
  asOf: asOfAfterEverything(),
  after: undefined,
  from,
  limit: 51,
  ...extra,
});

/** Asks the way the server does and the way it did, requires the same answer, and says which way it went. */
const bothWays = async (
  db: Executor,
  room: Room,
  as: string,
  window: ChangeWindow,
): Promise<Answer> => {
  const chosen = await changedRows(db, contextOf(room, as), window);
  const scanned = await changedRows(db, contextOf(room, as), window, 'scan');
  expect(scanned.read).toBe('scan');
  expect(JSON.stringify(chosen.rows)).toBe(JSON.stringify(scanned.rows));
  return { read: chosen.read, ids: chosen.rows.map((row) => row.id), rows: chosen.rows };
};

describe('integration: the changes of a channel, read by ids and read as a channel', () => {
  test('nothing new: nothing comes back, by ids, with a channel of old messages behind it', async () => {
    await withRoom(async (db, room) => {
      await insertAt(db, room, ago(30 * DAY));
      await insertAt(db, room, ago(10 * DAY));
      const { read, ids } = await bothWays(db, room, 'bob', windowFrom(ago(MINUTE)));
      expect({ read, ids }).toEqual({ read: 'ids', ids: [] });
    });
  });

  test('a few changes come back oldest change first, by ids, and are those the scan finds', async () => {
    await withRoom(async (db, room) => {
      await insertAt(db, room, ago(30 * DAY));
      // Another channel's change, which only a read that forgets the channel would bring.
      await insertAt(db, await aRoom(db, ['alice']), ago(2 * MINUTE));
      const other = await db
        .insertInto('channels')
        .values({
          workspace_id: room.workspaceId,
          name: 'another-readable-channel',
          type: 'public',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      // Current visibility also permits this public channel; it still does not belong in this walk.
      await db
        .insertInto('messages')
        .values({ ...rowAt(room, ago(2 * MINUTE)), channel_id: other.id })
        .execute();
      const first = await insertAt(db, room, ago(3 * MINUTE));
      const second = await insertAt(db, room, ago(2 * MINUTE));
      // Arrived late: its id is older than the first's, its change is newer than the second's.
      const late = await insertAt(db, room, ago(MINUTE), anId(ago(10 * MINUTE)));
      const { read, ids } = await bothWays(db, room, 'bob', windowFrom(ago(5 * MINUTE)));
      expect({ read, ids }).toEqual({ read: 'ids', ids: [first, second, late] });
    });
  });

  test('a message the caller hid is told at the hiding, to that caller alone', async () => {
    await withRoom(async (db, room) => {
      const old = await insertAt(db, room, ago(20 * DAY));
      const plain = await insertAt(db, room, ago(5 * MINUTE));
      await hide(db, room, 'bob', old, ago(2 * MINUTE));
      // Hidden by somebody else: it changes nothing for bob.
      const other = await insertAt(db, room, ago(20 * DAY));
      await hide(db, room, 'alice', other, ago(MINUTE));

      const bob = await bothWays(db, room, 'bob', windowFrom(ago(10 * MINUTE)));
      expect({ read: bob.read, ids: bob.ids }).toEqual({ read: 'ids', ids: [plain, old] });
      const alice = await bothWays(db, room, 'alice', windowFrom(ago(10 * MINUTE)));
      expect({ read: alice.read, ids: alice.ids }).toEqual({ read: 'ids', ids: [plain, other] });
    });
  });

  test('a message both changed and hidden inside the walk comes back once', async () => {
    await withRoom(async (db, room) => {
      const id = await insertAt(db, room, ago(5 * MINUTE));
      await hide(db, room, 'bob', id, ago(MINUTE));
      const { read, ids } = await bothWays(db, room, 'bob', windowFrom(ago(10 * MINUTE)));
      expect({ read, ids }).toEqual({ read: 'ids', ids: [id] });
    });
  });

  test('a message hidden before the walk and changed after it is told at the change', async () => {
    await withRoom(async (db, room) => {
      const id = await insertAt(db, room, ago(20 * DAY));
      await hide(db, room, 'bob', id, ago(10 * DAY));
      await db.updateTable('messages').set({ content: 'edited' }).where('id', '=', id).execute();
      const { read, ids } = await bothWays(db, room, 'bob', windowFrom(ago(MINUTE)));
      expect({ read, ids }).toEqual({ read: 'ids', ids: [id] });
    });
  });

  test('a deletion is told, as the row it leaves', async () => {
    await withRoom(async (db, room) => {
      const doomed = await insertAt(db, room, ago(5 * DAY));
      await insertAt(db, room, ago(4 * DAY));
      await db
        .updateTable('messages')
        .set({ deleted_at: new Date(), content: '' })
        .where('id', '=', doomed)
        .execute();
      const { read, ids } = await bothWays(db, room, 'bob', windowFrom(ago(MINUTE)));
      expect({ read, ids }).toEqual({ read: 'ids', ids: [doomed] });
    });
  });

  test('a reply changes its root as well, and both are told', async () => {
    await withRoom(async (db, room) => {
      const root = await insertAt(db, room, ago(9 * DAY));
      const reply = anId(new Date());
      await sendMessage(db, fixedClock(new Date()), contextOf(room, 'alice'), {
        id: reply,
        content: 'answer',
        parentId: root,
      });
      const { read, ids } = await bothWays(db, room, 'bob', windowFrom(ago(MINUTE)));
      expect(read).toBe('ids');
      expect(new Set(ids)).toEqual(new Set([root, reply]));
    });
  });

  test('a since from long ago, with more changes than ids are read for, is read as the channel', async () => {
    await withRoom(async (db, room) => {
      const rows = Array.from({ length: IDS_READ_MAX + 1 }, (_, index) =>
        rowAt(room, ago(400 * DAY - index * MINUTE)),
      );
      await db.insertInto('messages').values(rows).execute();
      const { read, ids } = await bothWays(
        db,
        room,
        'bob',
        windowFrom(ago(401 * DAY), { limit: 11 }),
      );
      expect(read).toBe('scan');
      expect(ids).toHaveLength(11);
    });
  });

  test('as many changes as ids are read for are read by ids, and one more is not', async () => {
    await withRoom(async (db, room) => {
      const rows = Array.from({ length: IDS_READ_MAX + 1 }, (_, index) =>
        rowAt(room, ago(2 * DAY - index * 1000)),
      );
      await db.insertInto('messages').values(rows.slice(0, IDS_READ_MAX)).execute();
      const full = await bothWays(db, room, 'bob', windowFrom(ago(3 * DAY), { limit: 5 }));
      expect(full.read).toBe('ids');
      await db.insertInto('messages').values(rows.slice(IDS_READ_MAX)).execute();
      const over = await bothWays(db, room, 'bob', windowFrom(ago(3 * DAY), { limit: 5 }));
      expect(over.read).toBe('scan');
    });
  });

  test('a walk in pages by a cursor finds the same pages both ways, and every change once', async () => {
    await withRoom(async (db, room) => {
      const made: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        made.push(await insertAt(db, room, ago((20 - index) * MINUTE)));
      }
      const hidden = await insertAt(db, room, ago(30 * DAY));
      await hide(db, room, 'bob', hidden, ago(13 * MINUTE));

      const asOf = asOfAfterEverything();
      const walked: string[] = [];
      let window = windowFrom(ago(60 * MINUTE), { asOf, limit: 4 });
      for (let pages = 0; pages < 10; pages += 1) {
        const { read, rows } = await bothWays(db, room, 'bob', window);
        expect(read).toBe('ids');
        const page = rows.slice(0, 3);
        walked.push(...page.map((row) => row.id));
        const last = page.at(-1);
        if (rows.length <= 3 || last === undefined) break;
        const after = { changedAt: last.changed_at, messageId: last.id, asOf };
        window = { ...window, after, from: after.changedAt };
      }
      expect(walked).toHaveLength(8);
      expect(new Set(walked)).toEqual(new Set([...made, hidden]));
    });
  });
});
