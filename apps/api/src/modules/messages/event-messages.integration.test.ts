/**
 * A message nobody wrote (#79, D-134 §6): a repository's event. It is read with every page, with no
 * sender and its event; the database refuses a person's message without a sender and an event with
 * one; it counts as unread for everybody; nobody edits it, an admin may remove it; and a reply or a
 * resolution under it tells nobody on its behalf.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireChannelById, requireMessageById } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { channelPins, pinMessage } from '../pins/pins';
import { saveMessage, savedPage } from '../saved/saved';
import { searchIn } from '../search/search';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { A_PUSH, anEventMessage } from '../../testing/github-events';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { markRead } from '../channels/read-state';
import { removeMessage } from './delete';
import { reviseMessage } from './edit';
import { messageHistory, missedIn, sendMessage } from './messages';
import { readBuilt } from './reader';
import { setResolved, threadReplies, unresolvedIn } from './threads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

const idOf = (room: Room, name: string): string => {
  const member = room.members[name];
  if (member === undefined) throw new Error(`no ${name}`);
  return member.userId;
};

const refusal = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'done',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

const quietBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const reply = async (
  db: Executor,
  room: Room,
  as: string,
  parentId: string,
  at: Date,
): Promise<string> => {
  const member = room.members[as];
  if (member === undefined) throw new Error(`no ${as}`);
  const sent = await sendMessage(db, fixedClock(at), member.context, {
    id: messageId(at),
    content: 'about that push',
    parentId,
  });
  return sent.message.id;
};

describe('integration: a message nobody wrote', () => {
  test('is read with the page: no sender, its event; a person’s beside it keeps theirs', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const event = await anEventMessage(db, room, NOW);
      const alice = room.members['alice']?.context;
      if (alice === undefined) throw new Error('no alice');
      await sendMessage(db, fixedClock(later(1000)), alice, {
        id: messageId(later(1000)),
        content: 'nice',
      });

      const page = await messageHistory(db, alice);
      // Newest first, as a page is.
      expect(page.data.map((m) => [m.id === event, m.sender?.id ?? null, m.githubEvent])).toEqual([
        [false, idOf(room, 'alice'), null],
        [true, null, A_PUSH],
      ]);
    });
  });

  test('every reader that lists messages lists it: a replay, a thread, the open questions, pins, saved, search', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = idOf(room, 'alice');
      const context = await requireChannelById(db, alice, room.channelId);
      const workspace = await requireWorkspaceMembership(db, alice, room.workspaceId);
      const before = messageId(new Date(NOW.getTime() - 1000));
      const event = await anEventMessage(db, room, NOW);
      const answer = await reply(db, room, 'bob', event, later(1000));
      await pinMessage(db, clock, alice, event);
      await saveMessage(db, clock, alice, event, {});
      const target = await requireMessageById(db, alice, event);
      // Each reader, and the message it must return: the event, or under it, the reply to it.
      const read: Record<string, [readonly string[] | undefined, string]> = {
        replay: [
          (await missedIn(db, [{ context, after: before }], 10))
            .get(room.channelId)
            ?.data.map((m) => m.id),
          event,
        ],
        thread: [(await threadReplies(db, target, {})).data.map((m) => m.id), answer],
        questions: [
          (await unresolvedIn(db, workspace, [room.channelId])).data.map((m) => m.id),
          event,
        ],
        pins: [(await channelPins(db, context)).map((pin) => pin.message.id), event],
        saved: [
          (await savedPage(db, workspace, { state: 'in_progress' })).data.map(
            (item) => item.message.id,
          ),
          event,
        ],
        search: [
          (await searchIn(db, workspace, [room.channelId], { q: 'pushed' })).data.map((m) => m.id),
          event,
        ],
      };
      for (const [reader, [ids, wanted]] of Object.entries(read)) {
        expect({ reader, has: ids?.includes(wanted) ?? false }).toEqual({ reader, has: true });
      }
    });
  });

  test('the database holds the rule: a person’s message has a sender, an event has none', async () => {
    for (const values of [
      { sender: false, type: 'text' as const },
      { sender: true, type: 'system_event' as const },
    ]) {
      let outcome = 'not tried';
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice']);
        outcome = await db
          .insertInto('messages')
          .values({
            id: messageId(NOW),
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: values.sender ? idOf(room, 'alice') : null,
            message_type: values.type,
            content: 'either way',
          })
          .execute()
          .then(
            () => 'written',
            (error: unknown) => (error instanceof Error ? error.message : 'not an error'),
          );
      });
      expect({ values, refused: outcome.includes('messages_sender_by_type') }).toEqual({
        values,
        refused: true,
      });
    }
  });

  test('counts as unread for everybody, read again from the rows', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice']?.context;
      if (alice === undefined) throw new Error('no alice');
      const first = await sendMessage(db, clock, alice, { id: messageId(NOW), content: 'before' });
      await anEventMessage(db, room, later(1000));
      await anEventMessage(db, room, later(2000));
      // The recount, from the rows: everything past the position that the reader did not write.
      await markRead(db, clock, alice, first.message.id);
      expect((await counters(db, room, idOf(room, 'alice'))).unread).toBe(2);
    });
  });

  test('nobody edits it, not even the admin who set the feed up', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const event = await anEventMessage(db, room, NOW);
      expect(await refusal(reviseMessage(db, clock, idOf(room, 'alice'), event, 'rewritten'))).toBe(
        'FORBIDDEN',
      );
      expect((await readBuilt(db, event))?.githubEvent).toEqual(A_PUSH);
    });
  });

  test('an admin removes it, on the trail with no author named; a member may not', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const event = await anEventMessage(db, room, NOW);
      expect(await refusal(removeMessage(db, clock, idOf(room, 'bob'), event))).toBe('FORBIDDEN');
      // Counted for everybody when it came, so taken back from everybody when it goes.
      const unread = async (): Promise<number[]> => [
        (await counters(db, room, idOf(room, 'alice'))).unread,
        (await counters(db, room, idOf(room, 'bob'))).unread,
      ];
      expect(await unread()).toEqual([1, 1]);

      await removeMessage(db, clock, idOf(room, 'alice'), event);
      expect(await unread()).toEqual([0, 0]);
      const tombstone = await readBuilt(db, event);
      expect([tombstone?.deletedAt, tombstone?.sender, tombstone?.githubEvent]).toEqual([
        NOW.toISOString(),
        null,
        null,
      ]);
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'metadata'])
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(trail).toEqual([{ action: 'message.removed_by_moderator', metadata: {} }]);
    });
  });

  test('a reply under it, and its resolution, tell nobody on its behalf', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const event = await anEventMessage(db, room, NOW);
      await reply(db, room, 'bob', event, later(1000));
      // Alice answers too: bob, who replied before, is told as a participant — the thread works.
      const answer = await reply(db, room, 'alice', event, later(2000));
      expect(await notificationsOf(db, idOf(room, 'bob'))).toEqual([
        { messageId: answer, type: 'thread_reply' },
      ]);
      expect(await notificationsOf(db, idOf(room, 'alice'))).toEqual([]);

      await setResolved(
        { atomically: atomicallyOn(db), clock, bus: quietBus },
        idOf(room, 'alice'),
        event,
        true,
      );
      const resolved = await readBuilt(db, event);
      expect(resolved?.thread?.resolvedBy?.id).toBe(idOf(room, 'alice'));
      expect(
        (await notificationsOf(db, idOf(room, 'bob'))).filter((n) => n.type !== 'thread_reply'),
      ).toEqual([]);
    });
  });

  test('an event the contract cannot say: an unknown kind is refused by the table, a known kind out of shape is said loudly', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const event = await anEventMessage(db, room, NOW);
      const unknown = await db
        .updateTable('messages')
        .set({ metadata: { kind: 'deployment' } })
        .where('id', '=', event)
        .execute()
        .then(
          () => 'written',
          (error: unknown) => (error instanceof Error ? error.message : 'not an error'),
        );
      expect(unknown).toContain('messages_event_known');
    });
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const event = await anEventMessage(db, room, NOW);
      await db
        .updateTable('messages')
        .set({ metadata: { kind: 'push', repository: 'acme/api' } })
        .where('id', '=', event)
        .execute();
      const context = await requireChannelById(db, idOf(room, 'alice'), room.channelId);
      expect(await refusal(messageHistory(db, context))).toContain(
        'an event the contract cannot say',
      );
    });
  });
});
