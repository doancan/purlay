/**
 * Two members adding a channel's last bookmark at once (D-218), on a cloned database with real
 * connections — inside the harness's one transaction nothing races (D-46, D-77). The count is read
 * under the channel's row lock, so the second add waits for the first and then counts it: one gets in,
 * the other is told the channel is full. A trigger that sleeps holds the first insert inside its window.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { BOOKMARKS_MAX } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { NOW } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { addBookmark, channelBookmarks } from './bookmarks';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(cloned.db);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
});

const clock = fixedClock(NOW);

describe('integration: two members adding the last bookmark at once', () => {
  test('one gets in, the other is told the channel is full, and the bound holds', async () => {
    const room = await aRoom(cloned.db, ['alice', 'bob']);
    const alice = room.members['alice']?.context;
    const bob = room.members['bob']?.context;
    if (alice === undefined || bob === undefined) throw new Error('no members');
    for (let index = 0; index < BOOKMARKS_MAX - 1; index += 1) {
      await cloned.db.transaction().execute((transaction) =>
        addBookmark(transaction, clock, alice, {
          url: `https://example.com/${String(index)}`,
          title: `Link ${String(index)}`,
        }),
      );
    }
    const add = (context: typeof alice, url: string): Promise<string> =>
      cloned.db
        .transaction()
        .execute((transaction) => addBookmark(transaction, clock, context, { url, title: 'Last' }))
        .then(
          () => 'added',
          (failure: unknown) => {
            if (failure instanceof AppError) return failure.body.code;
            throw failure;
          },
        );

    await sql`create trigger hold before insert on channel_bookmarks for each row execute function hold_window()`.execute(
      cloned.db,
    );
    let answers: string[];
    try {
      answers = await Promise.all([
        add(alice, 'https://example.com/alice'),
        add(bob, 'https://example.com/bob'),
      ]);
    } finally {
      await sql`drop trigger hold on channel_bookmarks`.execute(cloned.db);
    }
    expect(answers.toSorted()).toEqual(['BOOKMARKS_LIMIT', 'added']);
    expect(await channelBookmarks(cloned.db, alice)).toHaveLength(BOOKMARKS_MAX);
  });
});
