/**
 * A channel's bookmarks (D-218): links its members keep at hand, under the channel's header.
 *
 * - **Read by whoever can see the channel**, as its pins are; **added and removed by its members**.
 * - **The same address again is the same bookmark**: added twice, the first stays and nothing changes,
 *   so a double click or a retry is not a second chip.
 * - **Bounded**: at most `BOOKMARKS_MAX` a channel, counted under the channel's row lock, so two members
 *   adding the last one at once cannot both get in.
 * - **Only the web**: an address is `http:` or `https:` as the contract's pattern says, and parsed here
 *   as a URL too, so nothing a browser would run (`javascript:`) is ever kept.
 */
import type { Executor, Transaction } from '@purlay/db';
import {
  BOOKMARKS_MAX,
  messageId as newId,
  type BookmarkList,
  type ChannelBookmark,
} from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import { requireChannelMember, type ChannelContext } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';

const at = (value: Date | string): string => new Date(value).toISOString();

export interface BookmarkChange {
  readonly channelId: string;
  readonly changed: boolean;
}

const notFound = (): AppError =>
  new AppError({ code: 'BOOKMARK_NOT_FOUND', message: 'Bookmark not found.' });

/** The channel's row, held for the rest of the transaction: two members' adds take turns. */
const lockForMember = async (transaction: Transaction, context: ChannelContext): Promise<void> => {
  await requireChannelMember(transaction, context, 'Join the channel to change its bookmarks.');
  await transaction
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    // NO KEY UPDATE: the lock a send's own write takes, so a message pointing here is not made to wait.
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
};

const columns = [
  'channel_bookmarks.id as id',
  'channel_bookmarks.channel_id as channel_id',
  'channel_bookmarks.url as url',
  'channel_bookmarks.title as title',
  'channel_bookmarks.added_at as added_at',
  'users.id as user_id',
  'users.username as username',
  'users.display_name as display_name',
  'users.avatar_url as avatar_url',
] as const;

interface Row {
  readonly id: string;
  readonly channel_id: string;
  readonly url: string;
  readonly title: string;
  readonly added_at: Date | string;
  readonly user_id: string | null;
  readonly username: string | null;
  readonly display_name: string | null;
  readonly avatar_url: string | null;
}

const bookmarkOf = (row: Row): ChannelBookmark => ({
  id: row.id,
  channelId: row.channel_id,
  url: row.url,
  title: row.title,
  addedBy:
    row.user_id === null || row.username === null || row.display_name === null
      ? null
      : {
          id: row.user_id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
        },
  addedAt: at(row.added_at),
});

/** `http:` or `https:`, parsed as a browser would; anything else is refused with the field named. */
const webAddress = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    parsed = new URL('invalid:');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A bookmark is a web address.',
      details: { fields: { url: 'Use an http or https address.' } },
    });
  }
  return url;
};

export const channelBookmarks = async (
  executor: Executor,
  context: ChannelContext,
): Promise<BookmarkList> => {
  const rows = await executor
    .selectFrom('channel_bookmarks')
    .leftJoin('users', 'users.id', 'channel_bookmarks.added_by')
    .select(columns)
    .where('channel_bookmarks.channel_id', '=', context.channelId)
    .orderBy('channel_bookmarks.added_at', 'asc')
    .orderBy('channel_bookmarks.id', 'asc')
    .limit(BOOKMARKS_MAX)
    .execute();
  return rows.map(bookmarkOf);
};

export const addBookmark = async (
  transaction: Transaction,
  clock: Clock,
  context: ChannelContext,
  input: { readonly url: string; readonly title: string },
): Promise<{ readonly bookmark: ChannelBookmark; readonly change: BookmarkChange }> => {
  const url = webAddress(input.url);
  const title = input.title.trim();
  if (title === '') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'A bookmark has a name.',
      details: { fields: { title: 'Give it a name.' } },
    });
  }
  await lockForMember(transaction, context);
  const read = async (): Promise<ChannelBookmark | undefined> => {
    const row = await transaction
      .selectFrom('channel_bookmarks')
      .leftJoin('users', 'users.id', 'channel_bookmarks.added_by')
      .select(columns)
      .where('channel_bookmarks.channel_id', '=', context.channelId)
      .where('channel_bookmarks.url', '=', url)
      .executeTakeFirst();
    return row === undefined ? undefined : bookmarkOf(row);
  };
  const existing = await read();
  if (existing !== undefined) {
    return { bookmark: existing, change: { channelId: context.channelId, changed: false } };
  }
  const counted = await transaction
    .selectFrom('channel_bookmarks')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('channel_id', '=', context.channelId)
    .executeTakeFirstOrThrow();
  if (Number(counted.count) >= BOOKMARKS_MAX) {
    throw new AppError({
      code: 'BOOKMARKS_LIMIT',
      message: `At most ${String(BOOKMARKS_MAX)} bookmarks a channel; remove one first.`,
    });
  }
  await transaction
    .insertInto('channel_bookmarks')
    .values({
      id: newId(clock.now()),
      channel_id: context.channelId,
      workspace_id: context.workspaceId,
      url,
      title,
      added_by: context.userId,
      added_at: clock.now(),
    })
    .execute();
  const added = await read();
  if (added === undefined) throw new Error('a bookmark just added is not there');
  return { bookmark: added, change: { channelId: context.channelId, changed: true } };
};

/**
 * Removes one of this channel's bookmarks, for a member. One that is not this channel's — another's, or
 * none — is the one 404: the channel is what the caller was found able to see (D-34).
 */
export const removeBookmark = async (
  transaction: Transaction,
  context: ChannelContext,
  bookmarkId: string,
): Promise<BookmarkChange> => {
  if (!Value.Check(Uuid, bookmarkId)) throw notFound();
  await lockForMember(transaction, context);
  const removed = await transaction
    .deleteFrom('channel_bookmarks')
    .where('id', '=', bookmarkId)
    .where('channel_id', '=', context.channelId)
    .executeTakeFirst();
  if (removed.numDeletedRows === 0n) throw notFound();
  return { channelId: context.channelId, changed: true };
};
