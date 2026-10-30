/**
 * A channel's bookmarks against the real database (D-218): a member adds and removes, the same address
 * twice is one bookmark, the bound holds, only the web is kept, a visible non-member reads but is
 * refused a change, and a bookmark is only ever removed through its own channel.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { BOOKMARKS_MAX, messageId } from '@purlay/types';
import { requireChannelById, type ChannelContext } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { attempt } from '../../testing/attempt';
import { aRoom, type Room } from '../../testing/rooms';
import { addBookmark, channelBookmarks, removeBookmark } from './bookmarks';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-31T12:00:00.000Z');
/** A clock at `seconds` past NOW: bookmarks added later are listed later. */
const at = (seconds: number): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + seconds * 1000));

const contextOf = (room: Room, name: string): NonNullable<Room['members'][string]>['context'] => {
  const context = room.members[name]?.context;
  if (context === undefined) throw new Error(`no ${name}`);
  return context;
};

const outsiderContext = async (db: Executor, room: Room, name: string): Promise<ChannelContext> =>
  await requireChannelById(db, room.outsiders[name]?.userId ?? '', room.channelId);

const DOCS = { url: 'https://docs.example.com/runbook', title: 'Runbook' };

describe('integration: channel bookmarks', () => {
  test('a member adds, the same address again changes nothing, and removing is once', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const alice = contextOf(room, 'alice');

      const first = await addBookmark(db, at(0), alice, { ...DOCS, title: '  Runbook  ' });
      expect(first.change).toEqual({ channelId: room.channelId, changed: true });
      expect(first.bookmark).toMatchObject({
        channelId: room.channelId,
        url: DOCS.url,
        title: 'Runbook',
        addedAt: NOW.toISOString(),
      });
      expect(first.bookmark.addedBy?.id).toBe(room.members['alice']?.userId);

      // Bob adds the same address under another name: the first stays, by whom and as named.
      const again = await addBookmark(db, at(5), contextOf(room, 'bob'), {
        url: DOCS.url,
        title: 'Other',
      });
      expect(again.change.changed).toBe(false);
      expect(again.bookmark).toEqual(first.bookmark);

      const later = await addBookmark(db, at(10), alice, {
        url: 'http://grafana.local/d/1',
        title: 'Dashboard',
      });
      expect((await channelBookmarks(db, alice)).map((b) => b.title)).toEqual([
        'Runbook',
        'Dashboard',
      ]);

      expect(await removeBookmark(db, contextOf(room, 'bob'), first.bookmark.id)).toEqual({
        channelId: room.channelId,
        changed: true,
      });
      expect(await attempt(db, () => removeBookmark(db, alice, first.bookmark.id))).toBe(
        'BOOKMARK_NOT_FOUND',
      );
      expect((await channelBookmarks(db, alice)).map((b) => b.id)).toEqual([later.bookmark.id]);
    });
  });

  test('only http and https are kept, and a name is required', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example', 'nope']) {
        expect(await attempt(db, () => addBookmark(db, at(0), alice, { url, title: 'x' }))).toBe(
          'VALIDATION_FAILED',
        );
      }
      expect(
        await attempt(db, () => addBookmark(db, at(0), alice, { url: DOCS.url, title: '   ' })),
      ).toBe('VALIDATION_FAILED');
      expect(await channelBookmarks(db, alice)).toEqual([]);
    });
  });

  test('the bound holds at BOOKMARKS_MAX, and an address already there is still an answer', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice']);
      const alice = contextOf(room, 'alice');
      for (let index = 0; index < BOOKMARKS_MAX; index += 1) {
        await addBookmark(db, at(index), alice, {
          url: `https://example.com/${String(index)}`,
          title: `Link ${String(index)}`,
        });
      }
      expect(
        await attempt(db, () =>
          addBookmark(db, at(99), alice, { url: 'https://example.com/more', title: 'More' }),
        ),
      ).toBe('BOOKMARKS_LIMIT');
      const existing = await addBookmark(db, at(99), alice, {
        url: 'https://example.com/0',
        title: 'Again',
      });
      expect(existing.change.changed).toBe(false);
      expect(await channelBookmarks(db, alice)).toHaveLength(BOOKMARKS_MAX);
    });
  });

  test('a workspace member who can see the channel reads its bookmarks but is refused a change', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice'], { outsiders: ['carol'] });
      const { bookmark } = await addBookmark(db, at(0), contextOf(room, 'alice'), DOCS);
      const carol = await outsiderContext(db, room, 'carol');

      expect((await channelBookmarks(db, carol)).map((b) => b.id)).toEqual([bookmark.id]);
      expect(
        await attempt(db, () =>
          addBookmark(db, at(1), carol, { url: 'https://x.example', title: 'x' }),
        ),
      ).toBe('NOT_A_CHANNEL_MEMBER');
      expect(await attempt(db, () => removeBookmark(db, carol, bookmark.id))).toBe(
        'NOT_A_CHANNEL_MEMBER',
      );
      expect(await channelBookmarks(db, carol)).toHaveLength(1);
    });
  });

  test("another channel's bookmark, an unknown id, and a malformed one are the one 404", async () => {
    await withRollback(async (db) => {
      const here = await aRoom(db, ['alice']);
      const there = await aRoom(db, ['alice']);
      const { bookmark } = await addBookmark(db, at(0), contextOf(there, 'alice'), DOCS);
      const alice = contextOf(here, 'alice');

      for (const id of [bookmark.id, messageId(NOW), 'not-a-uuid']) {
        expect(await attempt(db, () => removeBookmark(db, alice, id))).toBe('BOOKMARK_NOT_FOUND');
      }
      expect(await channelBookmarks(db, contextOf(there, 'alice'))).toHaveLength(1);
    });
  });

  test("a person's erasure leaves their bookmark, by no one", async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await addBookmark(db, at(0), contextOf(room, 'bob'), DOCS);
      await db
        .deleteFrom('users')
        .where('id', '=', room.members['bob']?.userId ?? '')
        .execute();
      const [kept] = await channelBookmarks(db, contextOf(room, 'alice'));
      expect(kept?.addedBy).toBeNull();
      expect(kept?.url).toBe(DOCS.url);
    });
  });
});
