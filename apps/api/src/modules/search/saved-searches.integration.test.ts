import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId, SAVED_SEARCH_LIMIT } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { aRoom } from '../../testing/rooms';
import { listSearches, saveSearch, removeSearch } from './saved-searches';

afterAll(closeIntegrationDatabase);
const refusalOf = async (operation: Promise<unknown>): Promise<unknown> =>
  await operation.then(
    (): unknown => null,
    (error: unknown): unknown => error,
  );
const clock = fixedClock(new Date('2026-10-28T12:00:00Z'));

describe('integration: personal saved searches', () => {
  test('the personal cap refuses new searches, allows updates and rejects invalid names and hidden channels', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = room.members['alice'];
      if (alice === undefined) throw new Error('missing member');
      const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
      const input = { name: 'Question', query: { q: '', question: 'yes' as const } };
      expect(
        await refusalOf(
          saveSearch(db, clock, context, messageId(clock.now()), { ...input, name: '  ' }),
        ),
      ).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
      expect(await refusalOf(saveSearch(db, clock, context, 'bad-id', input))).toMatchObject({
        body: { code: 'SAVED_SEARCH_NOT_FOUND' },
      });
      expect(await refusalOf(removeSearch(db, context, 'bad-id'))).toMatchObject({
        body: { code: 'SAVED_SEARCH_NOT_FOUND' },
      });
      expect(
        await refusalOf(
          saveSearch(db, clock, context, messageId(clock.now()), {
            ...input,
            query: { q: '', channelId: crypto.randomUUID() },
          }),
        ),
      ).toMatchObject({ body: { code: 'CHANNEL_NOT_FOUND' } });
      const ids = Array.from({ length: SAVED_SEARCH_LIMIT }, () => messageId(clock.now()));
      await db
        .insertInto('saved_searches')
        .values(
          ids.map((id) => ({
            id,
            workspace_id: room.workspaceId,
            user_id: alice.userId,
            name: 'Existing',
            query: JSON.stringify(input.query),
          })),
        )
        .execute();
      expect(
        await refusalOf(saveSearch(db, clock, context, messageId(clock.now()), input)),
      ).toMatchObject({ body: { code: 'SAVED_SEARCH_LIMIT' } });
      const first = ids[0];
      if (first === undefined) throw new Error('missing search');
      expect((await saveSearch(db, clock, context, first, input)).name).toBe('Question');
      await removeSearch(db, context, first);
      expect((await saveSearch(db, clock, context, messageId(clock.now()), input)).name).toBe(
        'Question',
      );
    });
  });

  test('saves filters once, paginates and never exposes or overwrites another person’s search', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = room.members['alice'];
      const bob = room.members['bob'];
      if (alice === undefined || bob === undefined) throw new Error('members missing');
      const context = await requireWorkspaceMembership(db, alice.userId, alice.context.workspaceId);
      const other = await requireWorkspaceMembership(db, bob.userId, bob.context.workspaceId);
      const id = messageId(clock.now());
      const input = {
        name: 'Resolved retries',
        query: { q: 'retry', status: 'resolved' as const },
      };
      const saved = await saveSearch(db, clock, context, id, input);
      expect(await saveSearch(db, clock, context, id, input)).toEqual(saved);
      expect((await listSearches(db, other, {})).data).toEqual([]);
      expect(await refusalOf(saveSearch(db, clock, other, id, input))).toMatchObject({
        body: { code: 'SAVED_SEARCH_NOT_FOUND' },
      });
      await removeSearch(db, other, id);
      expect((await listSearches(db, context, {})).data).toEqual([saved]);
      await saveSearch(db, clock, context, messageId(new Date(clock.now().getTime() + 1000)), {
        ...input,
        name: 'Another',
      });
      const first = await listSearches(db, context, { limit: 1 });
      expect(first.data).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      expect(
        (await listSearches(db, context, { before: first.nextCursor ?? '', limit: 1 })).data,
      ).toEqual([saved]);
      await removeSearch(db, context, id);
      expect((await listSearches(db, context, {})).data).toHaveLength(1);
    });
  });
});
