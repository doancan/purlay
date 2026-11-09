/**
 * The message endpoints Phase 0 serves (`API.md` §5).
 *
 * `POST` here is the **fallback when the socket is down**, running the same
 * service as the `MESSAGE_SEND` frame — the socket is an optimisation, never the
 * only path (`ARCHITECTURE.md` §5.1). One service, two entry points, so the two
 * cannot validate differently.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ChatRouteDependencies } from './dependencies';
import type { SessionAuth } from '../../../modules/auth/sessions';
import {
  EditMessageRequest,
  CatchUpQuery,
  type ChannelCatchUp,
  FileQuery,
  type FilePage,
  PageQuery,
  ChangesQuery,
  type ChangePage,
  SearchQuery,
  type SearchPage,
  SendMessageRequest,
  SetThreadFollowRequest,
  UnresolvedQuery,
  type Message,
  type ThreadFollow,
  type MessagePage,
  type MessageWindow,
} from '@purlay/types';
import type { Clock } from '../../../platform/clock';
import {
  channelNotFound,
  messageNotFound,
  requireChannelById,
  requireMessageById,
} from '../channels/guard';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { visibleChannelIds } from '../channels/guard';
import { messageHistory, messageWindow, send, type SendDependencies } from '../messages/messages';
import { changesIn } from '../messages/changes';
import { buildMessages, readMessage } from '../messages/reader';
import { edit } from '../messages/edit';
import { deleteMessage } from '../messages/delete';
import {
  setResolved,
  threadReplies,
  unresolvedIn,
  type ResolveDependencies,
} from '../messages/threads';
import { followState, setFollowing } from '../messages/follow';
import { searchIn } from '../search/search';
import { channelFiles } from '../channels/files';
import { catchUpIn } from '../channels/catch-up';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';

/** Reading needs the database and the clock, and nothing that publishes. */
export interface HistoryDependencies {
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: SessionAuth;
  readonly database: ChatRouteDependencies['database'];
  readonly clock: Clock;
}

/** Sending needs the one send path's boundary and bus as well. */
interface MessageDependencies extends HistoryDependencies, SendDependencies {}

const readCatchUp = async (
  dependencies: HistoryDependencies,
  request: Request,
  channelId: string,
): Promise<ChannelCatchUp> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(dependencies.database, userId, channelId);
  const query = validated(CatchUpQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await catchUpIn(dependencies.database, context, query);
};

const readHistory = async (
  dependencies: HistoryDependencies,
  request: Request,
  channelId: string,
): Promise<MessagePage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(PageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await messageHistory(database, context, query);
};

/**
 * `GET /api/channels/:channelId/changes` — what happened to the channel's messages since the client last heard
 * (D-194). Seen as the history is: whoever can read the channel, and nobody else.
 */
const readChanges = async (
  dependencies: HistoryDependencies,
  request: Request,
  channelId: string,
): Promise<ChangePage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(ChangesQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await changesIn(database, context, query);
};

/** `GET /api/channels/:channelId/files` — the channel's files, newest message first (D-129). */
const readFiles = async (
  dependencies: HistoryDependencies,
  request: Request,
  channelId: string,
): Promise<FilePage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(FileQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await channelFiles(database, context, query);
};

const postMessage = async (
  dependencies: MessageDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<Message> => {
  const { database } = dependencies;
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(SendMessageRequest, body);
  return await send(dependencies, context, input, sessionId);
};

/**
 * `GET /api/messages/:messageId/thread` — the replies of a root, oldest first.
 *
 * The message is resolved to its channel and to the caller's right to see it in one
 * query, so a message that does not exist and one in a conversation the caller is not
 * in are the same `404` (D-34).
 */
const readThread = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<MessagePage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  // A deleted root with replies keeps its place in the feed, and its thread with it (D-103 §7).
  const root = await requireMessageById(database, userId, messageId, { deleted: 'include' });
  const query = validated(PageQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await threadReplies(database, root, query);
};

/**
 * `GET /api/messages/:messageId` — one message, for a card that a link to it is drawn as (D-217): a
 * forwarded message, or a link pasted. Found by the rule every route that names a message uses, so a
 * message deleted, never sent, or in a channel the caller cannot see is the one `404` (D-34): a link
 * someone else could follow shows nothing of what this reader may not see.
 */
const readOne = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<Message> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const found = await requireMessageById(database, userId, messageId);
  const row = await readMessage(database, found.messageId);
  if (row === undefined) throw messageNotFound();
  const [message] = await buildMessages(database, [row]);
  if (message === undefined) throw messageNotFound();
  return message;
};

/**
 * `GET /api/messages/:messageId/around` — the feed around a message, for a link to it (D-149). A
 * message deleted, never sent, or in a channel the caller cannot see is the one `404` (D-34).
 */
const readAround = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<MessageWindow> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  return await messageWindow(database, await requireMessageById(database, userId, messageId));
};

/**
 * `GET /api/messages/:messageId/follow` — whether the caller is told of this thread's replies (D-161).
 * Anybody who can see the root may ask; a deleted root with replies keeps its thread (D-103 §7).
 */
const readThreadFollow = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<ThreadFollow> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const root = await requireMessageById(database, userId, messageId, { deleted: 'include' });
  return await followState(database, root);
};

/**
 * `PUT /api/messages/:messageId/follow` — the caller's own choice about this thread (D-161). Their own,
 * as a save is: open to anybody who can see the root, a member of the channel or not (D-156 §3). Told
 * to nobody else, and not to the caller's other devices — they read it when they open the thread.
 */
const putThreadFollow = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<ThreadFollow> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const input = validated(SetThreadFollowRequest, body);
  const root = await requireMessageById(database, userId, messageId, { deleted: 'include' });
  return await setFollowing(database, clock, root, input.following);
};

/** `POST` and `DELETE /api/messages/:messageId/resolve` — close the thread, or reopen it. */
const setThreadResolution = async (
  dependencies: HistoryDependencies & ResolveDependencies,
  request: Request,
  messageId: string,
  resolved: boolean,
): Promise<Message> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  return await setResolved(dependencies, userId, messageId, resolved, sessionId);
};

/** `PATCH /api/messages/:messageId` — the author's new content (D-103). */
const editMessage = async (
  dependencies: HistoryDependencies & SendDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<Message> => {
  const caller = await requireSession(dependencies.auth, request);
  const input = validated(EditMessageRequest, body);
  return await edit(dependencies, caller, messageId, input.content);
};

/** `DELETE /api/messages/:messageId` — the author, or a workspace admin (D-103 §7). */
const removeMessage = async (
  dependencies: HistoryDependencies & SendDependencies,
  request: Request,
  messageId: string,
): Promise<void> => {
  const caller = await requireSession(dependencies.auth, request);
  await deleteMessage(dependencies, caller, messageId);
};

/**
 * `GET /api/workspaces/:workspaceId/unresolved` — the open-questions view.
 *
 * One of the two reads D-34 was written about: it spans channels, so it asks the
 * guard which ones the caller can see and reads inside that set and nowhere else.
 */
const readUnresolved = async (
  dependencies: HistoryDependencies,
  request: Request,
  workspaceId: string,
): Promise<MessagePage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { channelId: one, ...query } = validated(
    UnresolvedQuery,
    queryOf(new URL(request.url), { numbers: ['limit'] }),
  );
  // One channel's questions narrow the visible set and never widen it: a channel the caller cannot
  // see is not found, as search says it (D-34).
  const visible = await visibleChannelIds(database, context);
  if (one !== undefined && !visible.includes(one)) throw channelNotFound();
  return await unresolvedIn(database, context, one === undefined ? visible : [one], query);
};

/**
 * `GET /api/workspaces/:workspaceId/search` — the words, in the channels the caller can see
 * (D-105, D-34). `q` is trimmed before it is measured: three spaces and a letter are not a search.
 */
const readSearch = async (
  dependencies: HistoryDependencies,
  request: Request,
  workspaceId: string,
): Promise<SearchPage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = queryOf(new URL(request.url), { numbers: ['limit'] });
  // `q` is trimmed before it is measured: three spaces and a letter are not a search.
  if (typeof query['q'] === 'string') query['q'] = query['q'].trim();
  const search = validated(SearchQuery, query);
  return await searchIn(database, context, await visibleChannelIds(database, context), search);
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const messageRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/channels/:channelId/unreads',
      async ({ request, params }) => await readCatchUp(context, request, params.channelId),
    )
    .get(
      '/api/channels/:channelId/messages',
      async ({ request, params }) => await readHistory(context, request, params.channelId),
    )
    .get(
      '/api/channels/:channelId/changes',
      async ({ request, params }) => await readChanges(context, request, params.channelId),
    )
    .get(
      '/api/channels/:channelId/files',
      async ({ request, params }) => await readFiles(context, request, params.channelId),
    )
    .post('/api/channels/:channelId/messages', async ({ request, params, body, set }) => {
      set.status = 201;
      return await postMessage(context, request, params.channelId, body);
    })
    .delete('/api/messages/:messageId', async ({ request, params, set }) => {
      await removeMessage(context, request, params.messageId);
      set.status = 204;
      return null;
    })
    .patch(
      '/api/messages/:messageId',
      async ({ request, params, body }) =>
        await editMessage(context, request, params.messageId, body),
    )
    .get(
      '/api/messages/:messageId',
      async ({ request, params }) => await readOne(context, request, params.messageId),
    )
    .get(
      '/api/messages/:messageId/around',
      async ({ request, params }) => await readAround(context, request, params.messageId),
    )
    .get(
      '/api/messages/:messageId/thread',
      async ({ request, params }) => await readThread(context, request, params.messageId),
    )
    .get(
      '/api/messages/:messageId/follow',
      async ({ request, params }) => await readThreadFollow(context, request, params.messageId),
    )
    .put(
      '/api/messages/:messageId/follow',
      async ({ request, params, body }) =>
        await putThreadFollow(context, request, params.messageId, body),
    )
    .post(
      '/api/messages/:messageId/resolve',
      async ({ request, params }) =>
        await setThreadResolution(context, request, params.messageId, true),
    )
    .delete(
      '/api/messages/:messageId/resolve',
      async ({ request, params }) =>
        await setThreadResolution(context, request, params.messageId, false),
    )
    .get(
      '/api/workspaces/:workspaceId/unresolved',
      async ({ request, params }) => await readUnresolved(context, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/search',
      async ({ request, params }) => await readSearch(context, request, params.workspaceId),
    );
