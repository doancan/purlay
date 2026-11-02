/**
 * A channel's bookmarks through HTTP (D-218): the list, add, remove. A change tells everyone watching
 * the channel (`BOOKMARKS_UPDATED`), after the commit, and only when it was one.
 */
import type { BookmarkList, ChannelBookmark } from '@purlay/types';
import { AddBookmarkRequest } from '@purlay/types';
import { requireChannelById } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishBookmarksUpdated,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import {
  addBookmark,
  channelBookmarks,
  removeBookmark,
  type BookmarkChange,
} from '../../modules/bookmarks/bookmarks';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';
import { validated } from './validate';

const told = async (
  { bus, clock, log = NO_LOG }: ChannelWriteDependencies,
  change: BookmarkChange,
): Promise<void> => {
  if (!change.changed) return;
  await publishAfterCommit(log, [
    [publication('BOOKMARKS_UPDATED', () => publishBookmarksUpdated(bus, clock, change.channelId))],
  ]);
};

/** `GET /api/channels/:channelId/bookmarks` — oldest first, bounded by `BOOKMARKS_MAX`. */
export const listBookmarks = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<BookmarkList> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelBookmarks(database, context);
};

/** `POST /api/channels/:channelId/bookmarks` — `201` with the bookmark; the same address, the same one. */
export const postBookmark = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<ChannelBookmark> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const input = validated(AddBookmarkRequest, body);
  const context = await requireChannelById(database, userId, channelId);
  const { bookmark, change } = await atomicallyOn(database)(
    async (transaction) => await addBookmark(transaction, clock, context, input),
  );
  await told(dependencies, change);
  return bookmark;
};

/** `DELETE /api/channels/:channelId/bookmarks/:bookmarkId` — `204`; not this channel's, the one 404. */
export const deleteBookmark = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  bookmarkId: string,
): Promise<void> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const change = await atomicallyOn(database)(
    async (transaction) => await removeBookmark(transaction, context, bookmarkId),
  );
  await told(dependencies, change);
};
