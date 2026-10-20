/**
 * A thread read, closed and reopened, and the workspace's open questions
 * (`UX.md` §4, D-99 §5), against a real database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { fixedClock } from '../../platform/clock';
import { requireMessageById } from '../../platform/channels';
import { atomicallyOn } from '../../platform/transactions';
import type { EventBus } from '../../platform/events';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { visibleChannelIds } from '../../platform/channels';
import { aRoom, counters, notificationsOf, type Room } from '../../testing/rooms';
import { sendMessage, type OutgoingMessage, type Sent } from './messages';
import { setResolved, threadReplies, unresolvedIn } from './threads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  extra: Partial<OutgoingMessage> = {},
  when = NOW,
): Promise<Sent> => {
  const member = room.members[as];
  if (member === undefined) throw new Error(`no member ${as}`);
  return await sendMessage(db, fixedClock(when), member.context, {
    id: messageId(when),
    content,
    ...extra,
  });
};

const recordingBus = (): { bus: EventBus; frames: ServerFrame[] } => {
  const frames: ServerFrame[] = [];
  const bus: EventBus = {
    publish: (_topic, frame) => {
      frames.push(frame);
      return Promise.resolve();
    },
    subscribe: () => false,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  return { bus, frames };
};

const refusalOf = async (attempt: Promise<unknown>): Promise<AppError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

const idOf = (room: Room, name: string): string => room.members[name]?.userId ?? '';

/** A thread with `replies` answers, oldest first; the root's id and the replies' ids. */
const aThread = async (
  db: Executor,
  room: Room,
  replies: number,
  [asker, answerer]: readonly [string, string] = ['alice', 'bob'],
): Promise<{ root: string; replies: string[] }> => {
  const root = (await post(db, room, asker, 'a question', {}, at(0))).message.id;
  const answers: string[] = [];
  for (let n = 1; n <= replies; n += 1) {
    answers.push(
      (
        await post(
          db,
          room,
          n % 2 === 0 ? asker : answerer,
          `answer ${String(n)}`,
          { parentId: root },
          at(n),
        )
      ).message.id,
    );
  }
  return { root, replies: answers };
};

describe('integration: reading a thread', () => {
  test('lists the replies oldest first, with the cursor to continue', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root, replies } = await aThread(db, room, 5);
      const target = await requireMessageById(db, idOf(room, 'bob'), root);

      const first = await threadReplies(db, target, { limit: 2 });
      expect(first.data.map((m) => m.id)).toEqual(replies.slice(0, 2));
      expect(first.nextCursor).toBe(replies[1] ?? null);
      expect(first.data[0]).toMatchObject({ parentId: root, thread: null });

      const next = await threadReplies(db, target, { after: first.nextCursor ?? '', limit: 2 });
      expect(next.data.map((m) => m.id)).toEqual(replies.slice(2, 4));

      const last = await threadReplies(db, target, { after: next.nextCursor ?? '', limit: 2 });
      expect(last.data.map((m) => m.id)).toEqual(replies.slice(4));
      expect(last.nextCursor).toBeNull();
    });
  });

  test('reads older replies newest first with `before`, as every page does', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root, replies } = await aThread(db, room, 4);
      const target = await requireMessageById(db, idOf(room, 'bob'), root);
      const page = await threadReplies(db, target, { before: replies[3] ?? '', limit: 2 });
      expect(page.data.map((m) => m.id)).toEqual(replies.slice(1, 3).reverse());
      expect(page.nextCursor).toBe(replies[1] ?? null);
    });
  });

  test('an unread cursor in both directions has no meaning', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 1);
      const target = await requireMessageById(db, idOf(room, 'bob'), root);
      const refusal = await refusalOf(threadReplies(db, target, { before: root, after: root }));
      expect(refusal.body.code).toBe('VALIDATION_FAILED');
    });
  });

  test('a reply has no thread, and an empty root has an empty one', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { replies } = await aThread(db, room, 1);
      const reply = await requireMessageById(db, idOf(room, 'bob'), replies[0] ?? '');
      expect((await refusalOf(threadReplies(db, reply))).body.code).toBe('MESSAGE_NOT_FOUND');

      const lonely = (await post(db, room, 'alice', 'nobody answered', {}, at(30))).message.id;
      const target = await requireMessageById(db, idOf(room, 'bob'), lonely);
      expect(await threadReplies(db, target)).toEqual({ data: [], nextCursor: null });
    });
  });

  test('caps a page at the contract’s maximum', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 3);
      const target = await requireMessageById(db, idOf(room, 'bob'), root);
      expect((await threadReplies(db, target, { limit: 10_000 })).data).toHaveLength(3);
      expect((await threadReplies(db, target, { limit: 0 })).data).toHaveLength(1);
    });
  });
});

describe('integration: resolving', () => {
  test('somebody who can see the public channel and is not in it can neither resolve nor reopen (D-156)', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { outsiders: ['erin'] });
      const { root } = await aThread(db, room, 1);
      const { bus, frames } = recordingBus();
      const dependencies = { atomically: atomicallyOn(db), clock, bus };
      const erin = room.outsiders['erin']?.userId ?? '';

      for (const resolved of [true, false]) {
        const refusal = await refusalOf(setResolved(dependencies, erin, root, resolved));
        expect(refusal.body.code).toBe('NOT_A_CHANNEL_MEMBER');
      }
      expect(frames).toEqual([]);
      const row = await db
        .selectFrom('messages')
        .select('resolved_at')
        .where('id', '=', root)
        .executeTakeFirstOrThrow();
      expect(row.resolved_at).toBeNull();
    });
  });

  const resolve = async (
    db: Executor,
    userId: string,
    id: string,
    resolved: boolean,
  ): Promise<{ message: Awaited<ReturnType<typeof setResolved>>; frames: ServerFrame[] }> => {
    const { bus, frames } = recordingBus();
    const message = await setResolved(
      { atomically: atomicallyOn(db), clock, bus },
      userId,
      id,
      resolved,
    );
    return { message, frames };
  };

  test('closes a thread with the person who did it, tells the room, and tells the author', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 2);
      const { message, frames } = await resolve(db, idOf(room, 'bob'), root, true);

      expect(message.thread).toMatchObject({
        replyCount: 2,
        resolvedAt: NOW.toISOString(),
        resolvedBy: { id: idOf(room, 'bob') },
      });
      expect(frames).toHaveLength(2);
      expect(frames[0]).toMatchObject({
        event: 'THREAD_UPDATED',
        data: {
          channelId: room.channelId,
          messageId: root,
          thread: { resolvedAt: NOW.toISOString() },
        },
      });
      // Then her inbox, after the room: a resolution moves no counter, so this is all that says it.
      expect(frames[1]).toMatchObject({
        event: 'NOTIFICATIONS_UPDATED',
        data: { workspaceId: room.workspaceId },
      });
      // Alice asked it, Bob closed it: she is told, and her counters do not move for it.
      const told = (await notificationsOf(db, idOf(room, 'alice'))).filter(
        (n) => n.type === 'thread_resolved',
      );
      expect(told).toEqual([{ messageId: root, type: 'thread_resolved' }]);
      const before = await counters(db, room, idOf(room, 'alice'));
      expect(before.unread).toBeGreaterThanOrEqual(before.mentions);
    });
  });

  test('closing your own thread tells nobody', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 1);
      const { frames } = await resolve(db, idOf(room, 'alice'), root, true);
      expect(frames.map((frame) => frame.event)).toEqual(['THREAD_UPDATED']);
      expect(
        (await notificationsOf(db, idOf(room, 'alice'))).filter(
          (n) => n.type === 'thread_resolved',
        ),
      ).toEqual([]);
    });
  });

  test('a muted author is not told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 1);
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'none' })
        .where('channel_id', '=', room.channelId)
        .where('user_id', '=', idOf(room, 'alice'))
        .execute();
      const { frames } = await resolve(db, idOf(room, 'bob'), root, true);
      expect(frames.map((frame) => frame.event)).toEqual(['THREAD_UPDATED']);
      expect(
        (await notificationsOf(db, idOf(room, 'alice'))).filter(
          (n) => n.type === 'thread_resolved',
        ),
      ).toEqual([]);
    });
  });

  test('closing a closed thread, or reopening an open one, changes nothing and says nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 1);

      const open = await resolve(db, idOf(room, 'bob'), root, false);
      expect(open.frames).toEqual([]);
      expect(open.message.thread?.resolvedAt).toBeNull();

      await resolve(db, idOf(room, 'bob'), root, true);
      const closed = await resolve(db, idOf(room, 'alice'), root, true);
      expect(closed.frames).toEqual([]);
      // The first resolver stays: a second click is not a second decision.
      expect(closed.message.thread?.resolvedBy?.id).toBe(idOf(room, 'bob'));
    });
  });

  test('reopens, and the room is told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 1);
      await resolve(db, idOf(room, 'bob'), root, true);
      const { message, frames } = await resolve(db, idOf(room, 'alice'), root, false);
      expect(message.thread).toMatchObject({ resolvedAt: null, resolvedBy: null, replyCount: 1 });
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        event: 'THREAD_UPDATED',
        data: { thread: { resolvedAt: null } },
      });
    });
  });

  test('a reply cannot be resolved or reopened, and a root nobody answered cannot be resolved', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { replies } = await aThread(db, room, 1);
      for (const resolved of [true, false]) {
        const refusal = await refusalOf(resolve(db, idOf(room, 'bob'), replies[0] ?? '', resolved));
        expect(refusal.body.code).toBe('THREAD_NOT_RESOLVABLE');
      }
      const lonely = (await post(db, room, 'alice', 'unanswered', {}, at(40))).message.id;
      expect((await refusalOf(resolve(db, idOf(room, 'bob'), lonely, true))).body.code).toBe(
        'THREAD_NOT_RESOLVABLE',
      );
      // Reopening one that is already open is not an error.
      expect(
        (await resolve(db, idOf(room, 'bob'), lonely, false)).message.thread?.resolvedAt,
      ).toBeNull();
    });
  });

  test('a person who cannot see the channel finds no such message', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private', outsiders: ['dave'] });
      const { root } = await aThread(db, room, 1);
      const dave = room.outsiders['dave']?.userId ?? '';
      expect((await refusalOf(resolve(db, dave, root, true))).body.code).toBe('MESSAGE_NOT_FOUND');
      expect((await refusalOf(resolve(db, dave, messageId(NOW), true))).body.code).toBe(
        'MESSAGE_NOT_FOUND',
      );
    });
  });

  test('a reply posted after resolving does not reopen it, and the summary follows it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const { root } = await aThread(db, room, 1);
      await resolve(db, idOf(room, 'bob'), root, true);
      const late = await post(db, room, 'alice', 'one more thing', { parentId: root }, at(60));
      expect(late.thread?.summary).toMatchObject({ replyCount: 2, resolvedAt: NOW.toISOString() });
    });
  });
});

describe('integration: two people resolving at once', () => {
  let cloned: ClonedDatabase;
  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
  });
  afterAll(async () => {
    await cloned.drop();
  });

  test('are two decisions in sequence: one change, one announcement, one notification', async () => {
    const db = cloned.db;
    const room = await aRoom(db, ['alice', 'bob', 'carol']);
    const { root } = await aThread(db, room, 2);
    const { bus, frames } = recordingBus();
    const dependencies = { atomically: atomicallyOn(db), clock, bus };

    const results = await Promise.all([
      setResolved(dependencies, idOf(room, 'bob'), root, true),
      setResolved(dependencies, idOf(room, 'carol'), root, true),
    ]);

    // Both answered with the thread closed — by whoever won, and the same one in both.
    expect(results[0].thread?.resolvedBy?.id).toBe(results[1].thread?.resolvedBy?.id);
    expect(frames.filter((f) => f.event === 'THREAD_UPDATED')).toHaveLength(1);
    expect(frames.filter((f) => f.event === 'NOTIFICATIONS_UPDATED')).toHaveLength(1);
    const told = (await notificationsOf(db, idOf(room, 'alice'))).filter(
      (n) => n.type === 'thread_resolved',
    );
    expect(told).toHaveLength(1);
  });
});

describe('integration: the open questions', () => {
  const view = async (db: Executor, room: Room, as: string, query = {}): Promise<string[]> => {
    const userId = idOf(room, as);
    const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
    const page = await unresolvedIn(db, context, await visibleChannelIds(db, context), query);
    return page.data.map((m) => m.id);
  };

  test('lists roots with a reply and no resolution, newest first, and nothing else', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const older = await aThread(db, room, 1);
      const closed = (await post(db, room, 'alice', 'closed', {}, at(100))).message.id;
      await post(db, room, 'bob', 'answer', { parentId: closed }, at(101));
      await setResolved(
        { atomically: atomicallyOn(db), clock, bus: recordingBus().bus },
        idOf(room, 'bob'),
        closed,
        true,
      );
      await post(db, room, 'alice', 'no replies yet', {}, at(110));
      const newer = (await post(db, room, 'bob', 'newer question', {}, at(120))).message.id;
      await post(db, room, 'alice', 'an answer', { parentId: newer }, at(121));

      expect(await view(db, room, 'alice')).toEqual([newer, older.root]);
    });
  });

  test('reopening puts a thread back, and paging walks the list', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const ids: string[] = [];
      for (let n = 0; n < 5; n += 1) {
        const root = (await post(db, room, 'alice', `q${String(n)}`, {}, at(n * 10))).message.id;
        await post(db, room, 'bob', 'a', { parentId: root }, at(n * 10 + 1));
        ids.push(root);
      }
      expect(await view(db, room, 'bob', { limit: 2 })).toEqual(ids.slice(3).reverse());
      const context = await requireWorkspaceMembership(db, idOf(room, 'bob'), room.workspaceId);
      const visible = await visibleChannelIds(db, context);
      const second = await unresolvedIn(db, context, visible, { before: ids[3] ?? '', limit: 2 });
      expect(second.data.map((m) => m.id)).toEqual(ids.slice(1, 3).reverse());
      expect(second.nextCursor).toBe(ids[1] ?? null);
      const forwards = await unresolvedIn(db, context, visible, { after: ids[2] ?? '', limit: 5 });
      expect(forwards.data.map((m) => m.id)).toEqual(ids.slice(3));
    });
  });

  test('is confined to the channels the caller can see, and to its own workspace', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private', outsiders: ['dave'] });
      await aThread(db, room, 1);
      const other = await aRoom(db, ['erin', 'frank']);
      const foreign = await aThread(db, other, 1, ['erin', 'frank']);

      expect(await view(db, room, 'alice')).toHaveLength(1);
      // Dave is in the workspace and not in the private channel: nothing of it.
      const dave = room.outsiders['dave']?.userId ?? '';
      const context = await requireWorkspaceMembership(db, dave, room.workspaceId);
      expect(await unresolvedIn(db, context, await visibleChannelIds(db, context))).toEqual({
        data: [],
        nextCursor: null,
      });
      expect(await view(db, room, 'alice')).not.toContain(foreign.root);
    });
  });

  test('with no visible channel there is nothing to ask the database', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const context = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      expect(await unresolvedIn(db, context, [])).toEqual({ data: [], nextCursor: null });
    });
  });

  test('asking in both directions is refused', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const context = await requireWorkspaceMembership(db, idOf(room, 'alice'), room.workspaceId);
      const refusal = await refusalOf(
        unresolvedIn(db, context, [room.channelId], {
          before: messageId(NOW),
          after: messageId(NOW),
        }),
      );
      expect(refusal.body.code).toBe('VALIDATION_FAILED');
    });
  });
});
