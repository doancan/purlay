/**
 * Search asks a message's words, its decision note and its accepted answer one query each (#1019).
 * Whatever it asks, the answer must be the one the single `OR` over the three gave: the same messages,
 * in the same order, on the same pages, for the same people. So the `OR` is kept here, as it was, and
 * every search below is run through both and the two compared.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { messageId, type SearchQuery } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { limitOf } from '../../../platform/pagination';
import { literalPattern } from '../../../platform/like-pattern';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { aRoom, type Room } from '../../../testing/rooms';
import { visibleChannelIds } from '../channels/guard';
import { notHiddenBy } from '../messages/hidden';
import { sendMessage } from '../messages/messages';
import { searchIn } from './search';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
/** Ids start before the clock (an id may be 60 s behind it, 5 s ahead), so thousands of them never run ahead. */
const ID_EPOCH = NOW.getTime() - 30_000;
const nextId = (): string => messageId(new Date(ID_EPOCH + (tick += 1) * 10));

/** More than search's look through the newest messages, so that older ones are the index's to find. */
const MORE_THAN_THE_NEWEST_LOOKED_THROUGH = 5100;

/** Ids a millisecond apart, newer than every id so far, without running the clock far ahead. */
const fillerIds = (count: number): string[] => {
  const base = ID_EPOCH + (tick + 1) * 10;
  tick += Math.ceil(count / 10) + 1;
  return Array.from({ length: count }, (_, index) => messageId(new Date(base + index)));
};

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
): Promise<string> =>
  (
    await sendMessage(db, clock, member(room, as).context, {
      id: nextId(),
      content,
      ...(parentId === undefined ? {} : { parentId }),
    })
  ).message.id;

const withNote = async (db: Executor, id: string, note: string): Promise<void> => {
  await db.updateTable('messages').set({ decision_note: note }).where('id', '=', id).execute();
};

const acceptedAnswerOf = async (db: Executor, id: string, answerId: string): Promise<void> => {
  await db
    .updateTable('messages')
    .set({ is_question: true, accepted_answer_id: answerId })
    .where('id', '=', id)
    .execute();
};

/** The search as it was: one `OR` over the words, the note and an `EXISTS` on the accepted answer. */
const legacyIds = async (
  db: Executor,
  room: Room,
  userId: string,
  query: SearchQuery,
): Promise<{ ids: string[]; nextCursor: string | null }> => {
  const visible = await visibleChannelIds(
    db,
    await requireWorkspaceMembership(db, userId, room.workspaceId),
  );
  const channelIds = query.channelId === undefined ? visible : [query.channelId];
  const limit = limitOf(query);
  if (channelIds.length === 0) return { ids: [], nextCursor: null };
  const pattern = literalPattern(query.q);
  let statement = db
    .selectFrom('messages')
    .leftJoin('messages as parent', 'parent.id', 'messages.parent_id')
    .select('messages.id')
    .where('messages.workspace_id', '=', room.workspaceId)
    .where('messages.channel_id', 'in', channelIds)
    .where('messages.deleted_at', 'is', null)
    .where(notHiddenBy(userId))
    .orderBy('messages.id', 'desc')
    .limit(limit + 1);
  if (query.q !== '') {
    statement = statement.where((eb) =>
      eb.or([
        eb(
          sql<string>`purlay_fold(messages.content)`,
          'like',
          sql<string>`purlay_fold(${pattern})`,
        ),
        eb(
          sql<string>`purlay_fold(messages.decision_note)`,
          'like',
          sql<string>`purlay_fold(${pattern})`,
        ),
        eb.exists(
          eb
            .selectFrom('messages as answer')
            .select('answer.id')
            .whereRef('answer.id', '=', 'messages.accepted_answer_id')
            .whereRef('answer.parent_id', '=', 'messages.id')
            .where('answer.deleted_at', 'is', null)
            .where(
              sql<string>`purlay_fold(answer.content)`,
              'like',
              sql<string>`purlay_fold(${pattern})`,
            ),
        ),
      ]),
    );
  }
  if (query.question === 'yes') statement = statement.where('messages.is_question', '=', true);
  if (query.status !== undefined) {
    statement = statement.where(
      sql`coalesce(parent.resolved_at, messages.resolved_at)`,
      query.status === 'resolved' ? 'is not' : 'is',
      null,
    );
  }
  if (query.before !== undefined) statement = statement.where('messages.id', '<', query.before);
  if (query.senderId !== undefined)
    statement = statement.where('messages.sender_id', '=', query.senderId);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    ids: page.map((row) => row.id),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/** What search finds for `userId`, beside what the `OR` finds: they must be the same, page and cursor. */
const bothFind = async (
  db: Executor,
  room: Room,
  userId: string,
  query: SearchQuery,
): Promise<{ ids: string[]; nextCursor: string | null }> => {
  const context = await requireWorkspaceMembership(db, userId, room.workspaceId);
  const page = await searchIn(db, context, await visibleChannelIds(db, context), query);
  const found = { ids: page.data.map((m) => m.id), nextCursor: page.nextCursor };
  expect(found).toEqual(await legacyIds(db, room, userId, query));
  return found;
};

describe('integration: the words, the note and the answer, each its own query (#1019)', () => {
  test('a term in the words only, the note only, the answer only, several places, and nowhere', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const as = member(room, 'alice').userId;
      const inWords = await post(db, room, 'alice', 'the zephyr rollout is on');
      const inNote = await post(db, room, 'alice', 'what did we decide about the vendor?');
      await withNote(db, inNote, 'Zephyr is the vendor we chose');
      const question = await post(db, room, 'alice', 'how do we restart it?');
      const answer = await post(db, room, 'bob', 'stop the ZEPHYR worker first', question);
      await acceptedAnswerOf(db, question, answer);
      const everywhere = await post(db, room, 'alice', 'zephyr everywhere');
      await withNote(db, everywhere, 'note: zephyr');
      const reply = await post(db, room, 'bob', 'yes, zephyr', everywhere);
      await acceptedAnswerOf(db, everywhere, reply);
      await post(db, room, 'alice', 'nothing of the kind');

      const found = await bothFind(db, room, as, { q: 'zephyr' });
      // The root of the thread whose accepted answer has the word is found, and so is the answer itself.
      expect(new Set(found.ids)).toEqual(
        new Set([inWords, inNote, question, answer, everywhere, reply]),
      );
      expect(found.ids).toEqual([...found.ids].sort().reverse());
      expect((await bothFind(db, room, as, { q: 'no such term' })).ids).toEqual([]);
    });
  });

  test("an answer counts only while it is the root's accepted reply and not deleted", async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const as = member(room, 'alice').userId;
      const gone = await post(db, room, 'alice', 'question one?');
      const goneAnswer = await post(db, room, 'bob', 'cobalt fix', gone);
      await acceptedAnswerOf(db, gone, goneAnswer);
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', goneAnswer)
        .execute();
      // A root whose accepted answer is another thread's reply: the answer is not its own.
      const other = await post(db, room, 'alice', 'question two?');
      const strangerAnswer = await post(db, room, 'bob', 'cobalt elsewhere', other);
      const third = await post(db, room, 'alice', 'question three?');
      await acceptedAnswerOf(db, third, strangerAnswer);
      // A deleted root with a note is not found for its note.
      const deletedRoot = await post(db, room, 'alice', 'a root to delete');
      await withNote(db, deletedRoot, 'cobalt decided');
      await db
        .updateTable('messages')
        .set({ deleted_at: NOW })
        .where('id', '=', deletedRoot)
        .execute();

      expect((await bothFind(db, room, as, { q: 'cobalt' })).ids).toEqual([strangerAnswer]);
    });
  });

  test('hidden for the reader, private channels, a channel and a sender narrow it the same way', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob'], { type: 'private', outsiders: ['carol'] });
      const other = await aRoom(db, ['dave']);
      const alice = member(room, 'alice');
      const bob = member(room, 'bob');
      const carol = room.outsiders['carol']?.userId ?? '';
      const seen = await post(db, room, 'alice', 'marble seen by both');
      const hiddenForAlice = await post(db, room, 'bob', 'marble hidden for alice');
      const noted = await post(db, room, 'bob', 'what did we pick?');
      await withNote(db, noted, 'marble, the stone');
      const answered = await post(db, room, 'alice', 'what do we use?');
      const marbleReply = await post(db, room, 'bob', 'marble', answered);
      await acceptedAnswerOf(db, answered, marbleReply);
      await db
        .insertInto('hidden_messages')
        .values({
          user_id: alice.userId,
          message_id: hiddenForAlice,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
        })
        .execute();
      // The note's and the answered root's own hiding hides them for alice, and for her alone.
      await db
        .insertInto('hidden_messages')
        .values({
          user_id: alice.userId,
          message_id: answered,
          channel_id: room.channelId,
          workspace_id: room.workspaceId,
        })
        .execute();
      await post(db, other, 'dave', 'marble in another workspace');

      const forAlice = await bothFind(db, room, alice.userId, { q: 'marble' });
      expect(forAlice.ids).not.toContain(hiddenForAlice);
      expect(forAlice.ids).not.toContain(answered);
      expect(forAlice.ids).toEqual([marbleReply, noted, seen]);
      expect((await bothFind(db, room, bob.userId, { q: 'marble' })).ids).toHaveLength(5);
      // Not in the channel: nothing, though the words are there.
      expect((await bothFind(db, room, carol, { q: 'marble' })).ids).toEqual([]);
      expect(
        (await bothFind(db, room, bob.userId, { q: 'marble', channelId: room.channelId })).ids,
      ).toHaveLength(5);
      expect(
        (await bothFind(db, room, bob.userId, { q: 'marble', senderId: alice.userId })).ids,
      ).toEqual([answered, seen]);
      expect(
        (await bothFind(db, room, bob.userId, { q: 'marble', senderId: bob.userId })).ids,
      ).toEqual([marbleReply, noted, hiddenForAlice]);
      expect((await bothFind(db, room, bob.userId, { q: 'marble', question: 'yes' })).ids).toEqual([
        answered,
      ]);
    });
  });

  test('İ, ı, I and i are one letter in the note and in the answer as in the words', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const as = member(room, 'alice').userId;
      const words = await post(db, room, 'alice', 'İstanbul toplantısı yarın');
      const noted = await post(db, room, 'alice', 'karar nedir?');
      await withNote(db, noted, 'ISPARTA seçildi, ÇAĞRI açık');
      const asked = await post(db, room, 'alice', 'ne yapalım?');
      const reply = await post(db, room, 'alice', 'ıspanak ve İSTANBUL', asked);
      await acceptedAnswerOf(db, asked, reply);
      for (const q of [
        'istanbul',
        'İSTANBUL',
        'ıstanbul',
        'ISTANBUL',
        'isparta',
        'ısparta',
        'çağrı',
        'ÇAĞRI',
        'ıspanak',
        'İSPANAK',
      ]) {
        await bothFind(db, room, as, { q });
      }
      expect(new Set((await bothFind(db, room, as, { q: 'istanbul' })).ids)).toEqual(
        new Set([words, asked, reply]),
      );
      expect((await bothFind(db, room, as, { q: 'ısparta' })).ids).toEqual([noted]);
      expect((await bothFind(db, room, as, { q: 'çağrı' })).ids).toEqual([noted]);
      expect(new Set((await bothFind(db, room, as, { q: 'İSPANAK' })).ids)).toEqual(
        new Set([asked, reply]),
      );
    });
  });

  test('pages of every size meet at the same boundaries, and walking them yields the same list', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const as = member(room, 'alice').userId;
      const everything: string[] = [];
      for (const n of [1, 2, 3, 4]) {
        everything.push(await post(db, room, 'alice', `quartz words ${String(n)}`));
        const noted = await post(db, room, 'alice', `decision ${String(n)}?`);
        await withNote(db, noted, `quartz note ${String(n)}`);
        everything.push(noted);
        const asked = await post(db, room, 'alice', `how ${String(n)}?`);
        const reply = await post(db, room, 'bob', `quartz answer ${String(n)}`, asked);
        await acceptedAnswerOf(db, asked, reply);
        everything.push(asked, reply);
      }
      for (const limit of [1, 2, 3, 5, 8, 16, 17, 50]) {
        const walked: string[] = [];
        let before: string | undefined;
        for (let guard = 0; guard < 40; guard += 1) {
          const page = await bothFind(db, room, as, {
            q: 'quartz',
            limit,
            ...(before === undefined ? {} : { before }),
          });
          walked.push(...page.ids);
          if (page.nextCursor === null) break;
          before = page.nextCursor;
        }
        expect(walked).toEqual([...everything].sort().reverse());
      }
    });
  });

  test('matches older than the newest messages are found, with the newer ones in front of them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const as = member(room, 'alice').userId;
      const oldWords = await post(db, room, 'alice', 'basalt in the old words');
      const oldNoted = await post(db, room, 'alice', 'an old decision?');
      await withNote(db, oldNoted, 'basalt, in the old note');
      const oldAsked = await post(db, room, 'alice', 'an old question?');
      const oldReply = await post(db, room, 'bob', 'basalt, old answer', oldAsked);
      await acceptedAnswerOf(db, oldAsked, oldReply);
      const sender = member(room, 'bob').userId;
      await db
        .insertInto('messages')
        .values(
          fillerIds(MORE_THAN_THE_NEWEST_LOOKED_THROUGH).map((id, index) => ({
            id,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: sender,
            // Every 1000th has the term, and so is among the newest.
            content:
              index % 1000 === 999 ? `filler basalt ${String(index)}` : `filler ${String(index)}`,
          })),
        )
        .execute();
      const newer = await bothFind(db, room, as, { q: 'basalt' });
      // 5 fillers carry the term and sit in front of the four old ones.
      expect(newer.ids).toHaveLength(9);
      expect(newer.ids.slice(5)).toEqual([oldReply, oldAsked, oldNoted, oldWords]);

      // A page that the newest fill alone, then one that reaches back, then the rest.
      expect((await bothFind(db, room, as, { q: 'basalt', limit: 3 })).ids).toHaveLength(3);
      expect((await bothFind(db, room, as, { q: 'basalt', limit: 7 })).ids).toHaveLength(7);
      const cursor = newer.ids[4] ?? '';
      expect((await bothFind(db, room, as, { q: 'basalt', limit: 2, before: cursor })).ids).toEqual(
        [oldReply, oldAsked],
      );
      expect((await bothFind(db, room, as, { q: 'no such term' })).ids).toEqual([]);
      expect(
        (await bothFind(db, room, as, { q: 'basalt', channelId: room.channelId, senderId: sender }))
          .ids,
      ).toHaveLength(5 + 1);
    });
  });

  test('a term in every one of the newest messages fills the page from them', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const as = member(room, 'alice').userId;
      await post(db, room, 'alice', 'ancient granite');
      await db
        .insertInto('messages')
        .values(
          fillerIds(MORE_THAN_THE_NEWEST_LOOKED_THROUGH).map((id, index) => ({
            id,
            workspace_id: room.workspaceId,
            channel_id: room.channelId,
            sender_id: member(room, 'alice').userId,
            content: `granite ${String(index)}`,
          })),
        )
        .execute();
      const first = await bothFind(db, room, as, { q: 'granite', limit: 50 });
      expect(first.ids).toHaveLength(50);
      expect(first.nextCursor).toBe(first.ids.at(-1) ?? null);
    });
  });
});
