/**
 * Searching a workspace (D-10, D-34, D-105): the words, ignoring case, in the channels the caller
 * can see and nowhere else; roots and replies, a resolved thread too, never a deleted message;
 * newest first, a page at a time.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireChannelById, visibleChannelIds } from '../../platform/channels';
import { atomicallyOn } from '../../platform/transactions';
import { NO_LOG, type EventBus } from '../../platform/events';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom, type Room } from '../../testing/rooms';
import { sendMessage, type Sent } from '../messages/messages';
import { searchIn } from './search';
import { setResolved } from '../messages/threads';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const nextId = (): string => messageId(new Date(NOW.getTime() + (tick += 1) * 10));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const post = async (
  db: Executor,
  room: Room,
  as: string,
  content: string,
  parentId?: string,
): Promise<Sent> =>
  await sendMessage(db, clock, member(room, as).context, {
    id: nextId(),
    content,
    ...(parentId === undefined ? {} : { parentId }),
  });

/** What `userId` finds for `q`, as the route asks: in every channel they can see. */
const search = async (
  db: Executor,
  room: Room,
  userId: string,
  q: string,
  extra: { before?: string; limit?: number; channelId?: string } = {},
): Promise<{ contents: string[]; nextCursor: string | null }> => {
  const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
  const page = await searchIn(db, context, await visibleChannelIds(db, context), {
    q,
    ...extra,
  });
  return { contents: page.data.map((m) => m.content), nextCursor: page.nextCursor };
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

const noBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

describe('integration: what is found', () => {
  test('the words inside a message, ignoring case, in roots and replies, newest first', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'Why is the RETRY backoff 4s?');
      await post(db, room, 'bob', 'the retry policy is documented', root.message.id);
      await post(db, room, 'alice', 'nothing to see');
      expect((await search(db, room, member(room, 'bob').userId, 'retry')).contents).toEqual([
        'the retry policy is documented',
        'Why is the RETRY backoff 4s?',
      ]);
    });
  });

  test('a resolved thread is still found, its question and its answer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const root = await post(db, room, 'alice', 'flaky deploy on friday');
      await post(db, room, 'bob', 'the deploy lock fixed it', root.message.id);
      await setResolved(
        { atomically: atomicallyOn(db), clock, bus: noBus, log: NO_LOG },
        member(room, 'alice').userId,
        root.message.id,
        true,
      );
      expect((await search(db, room, member(room, 'bob').userId, 'deploy')).contents).toHaveLength(
        2,
      );
    });
  });

  test('a deleted message is not found', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const sent = await post(db, room, 'alice', 'a secret token abc123');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', sent.message.id)
        .execute();
      expect((await search(db, room, member(room, 'alice').userId, 'abc123')).contents).toEqual([]);
    });
  });

  // `ILIKE` under the database's C ctype folds ASCII letters only (#700): every letter beyond them was
  // case-sensitive, and Turkish's four i's never met.
  test('case is ignored beyond ASCII, and I, ı, İ and i are one letter', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const as = member(room, 'alice').userId;
      await post(db, room, 'alice', 'İstanbul toplantısı yarın');
      await post(db, room, 'alice', 'ÇAĞRI merkezi');
      await post(db, room, 'alice', 'ılık su');
      await post(db, room, 'alice', 'Iğdır şubesi');
      await post(db, room, 'alice', 'Straße und ÄRGER');
      const found = async (q: string): Promise<string[]> =>
        (await search(db, room, as, q)).contents;
      expect(await found('istanbul')).toEqual(['İstanbul toplantısı yarın']);
      expect(await found('İSTANBUL')).toEqual(['İstanbul toplantısı yarın']);
      expect(await found('çağrı')).toEqual(['ÇAĞRI merkezi']);
      expect(await found('ILIK')).toEqual(['ılık su']);
      expect(await found('ığdır')).toEqual(['Iğdır şubesi']);
      expect(await found('IĞDIR')).toEqual(['Iğdır şubesi']);
      expect(await found('ärger')).toEqual(['Straße und ÄRGER']);
    });
  });

  test('%, _ and backslash are themselves, not patterns', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      await post(db, room, 'alice', 'coverage is 100% now');
      await post(db, room, 'alice', 'coverage is 1000 now');
      await post(db, room, 'alice', 'my_var and myXvar');
      await post(db, room, 'alice', 'C:\\path\\here');
      const as = member(room, 'alice').userId;
      expect((await search(db, room, as, '100%')).contents).toEqual(['coverage is 100% now']);
      expect((await search(db, room, as, 'my_var')).contents).toEqual(['my_var and myXvar']);
      expect((await search(db, room, as, ':\\pa')).contents).toEqual(['C:\\path\\here']);
    });
  });
});

describe('integration: where it looks', () => {
  for (const type of ['private', 'direct_message'] as const) {
    test(`never in a ${type} channel the caller is not in, though the words are there`, async () => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice'], { type, outsiders: ['bob'] });
        await post(db, room, 'alice', 'quarterly numbers are secret');
        const bob = room.outsiders['bob']?.userId ?? '';
        // The one inside finds it: the empty answer below is a refusal, not a search that misses.
        expect(
          (await search(db, room, member(room, 'alice').userId, 'quarterly')).contents,
        ).toEqual(['quarterly numbers are secret']);
        expect((await search(db, room, bob, 'quarterly')).contents).toEqual([]);
      });
    });
  }

  test('narrowed to one channel when asked, and only to one the caller can see', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const other = await db
        .insertInto('channels')
        .values({ workspace_id: room.workspaceId, name: 'other', type: 'public' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: other.id, user_id: member(room, 'alice').userId })
        .execute();
      await post(db, room, 'alice', 'deploy in general');
      await sendMessage(
        db,
        clock,
        await requireChannelById(db, member(room, 'alice').userId, other.id),
        { id: nextId(), content: 'deploy in other' },
      );
      const as = member(room, 'alice').userId;
      expect((await search(db, room, as, 'deploy')).contents).toHaveLength(2);
      expect((await search(db, room, as, 'deploy', { channelId: other.id })).contents).toEqual([
        'deploy in other',
      ]);

      // Another workspace's channel, and a private one somebody else is in: the same refusal.
      const elsewhere = await aRoom(db, ['carol']);
      const secret = await aRoom(db, ['dave'], { type: 'private' });
      for (const channelId of [elsewhere.channelId, secret.channelId]) {
        expect((await refusalOf(search(db, room, as, 'deploy', { channelId }))).body.code).toBe(
          'CHANNEL_NOT_FOUND',
        );
      }
    });
  });
});

describe('integration: a page at a time', () => {
  test('the limit, the cursor where it stopped, and the page after it', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      for (const n of [1, 2, 3]) await post(db, room, 'alice', `release ${String(n)}`);
      const as = member(room, 'alice').userId;
      const first = await search(db, room, as, 'release', { limit: 2 });
      expect(first.contents).toEqual(['release 3', 'release 2']);
      expect(first.nextCursor).not.toBeNull();
      const second = await search(db, room, as, 'release', {
        limit: 2,
        before: first.nextCursor ?? '',
      });
      expect(second).toEqual({ contents: ['release 1'], nextCursor: null });
    });
  });
});
