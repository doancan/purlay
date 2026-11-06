/**
 * A channel's bookmarks through HTTP (D-218): the list, add, remove. A change tells everyone watching
 * the channel (`BOOKMARKS_UPDATED`), after the commit, and only when it was one.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { BookmarkList, ChannelBookmark } from '@purlay/types';
import { AddBookmarkRequest } from '@purlay/types';
import { requireChannelById } from '../channels/guard';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishBookmarksUpdated,
} from '../../../platform/events';
import { atomicallyOn } from '../../../platform/transactions';
import {
  addBookmark,
  channelBookmarks,
  removeBookmark,
  type BookmarkChange,
} from '../bookmarks/bookmarks';
import type { ChannelDependencies, ChannelWriteDependencies } from '../../../ingress/http/channels';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

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
const listBookmarks = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<BookmarkList> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelBookmarks(database, context);
};

/** `POST /api/channels/:channelId/bookmarks` — `201` with the bookmark; the same address, the same one. */
const postBookmark = async (
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
const deleteBookmark = async (
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

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const bookmarkRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/channels/:channelId/bookmarks',
      async ({ request, params }) => await listBookmarks(context, request, params.channelId),
    )
    .post('/api/channels/:channelId/bookmarks', async ({ request, params, body, set }) => {
      const bookmark = await postBookmark(context, request, params.channelId, body);
      set.status = 201;
      return bookmark;
    })
    .delete('/api/channels/:channelId/bookmarks/:bookmarkId', async ({ request, params, set }) => {
      await deleteBookmark(context, request, params.channelId, params.bookmarkId);
      set.status = 204;
      return null;
    });
