/**
 * The message endpoints Phase 0 serves (`API.md` §5).
 *
 * `POST` here is the **fallback when the socket is down**, running the same
 * service as the `MESSAGE_SEND` frame — the socket is an optimisation, never the
 * only path (`ARCHITECTURE.md` §5.1). One service, two entry points, so the two
 * cannot validate differently.
 */
import type { Executor } from '@purlay/db';
import {
  EditMessageRequest,
  FileQuery,
  type FilePage,
  PageQuery,
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
import type { Clock } from '../../platform/clock';
import { channelNotFound, requireChannelById, requireMessageById } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { visibleChannelIds } from '../../platform/channels';
import {
  messageHistory,
  messageWindow,
  send,
  type SendDependencies,
} from '../../modules/messages/messages';
import { edit } from '../../modules/messages/edit';
import { deleteMessage } from '../../modules/messages/delete';
import {
  setResolved,
  threadReplies,
  unresolvedIn,
  type ResolveDependencies,
} from '../../modules/messages/threads';
import { followState, setFollowing } from '../../modules/messages/follow';
import { searchIn } from '../../modules/search/search';
import { channelFiles } from '../../modules/attachments/files';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/** Reading needs the database and the clock, and nothing that publishes. */
export interface HistoryDependencies {
  readonly database: Executor;
  readonly clock: Clock;
}

/** Sending needs the one send path's boundary and bus as well. */
export interface MessageDependencies extends HistoryDependencies, SendDependencies {}

/**
 * Query strings arrive as text. The contract's types are `integer` and `uuid`, so
 * `limit` is converted before validation rather than after — a string `"50"`
 * would otherwise be refused by the very schema that documents the default.
 */
const asPageQuery = (url: URL): Record<string, unknown> => {
  const query: Record<string, unknown> = {};
  for (const key of ['before', 'after'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = value;
  }
  const limit = url.searchParams.get('limit');
  if (limit !== null) query['limit'] = Number(limit);
  return query;
};

export const readHistory = async (
  dependencies: HistoryDependencies,
  request: Request,
  channelId: string,
): Promise<MessagePage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(PageQuery, asPageQuery(new URL(request.url)));
  return await messageHistory(database, context, query);
};

/** `GET /api/channels/:channelId/files` — the channel's files, newest message first (D-129). */
export const readFiles = async (
  dependencies: HistoryDependencies,
  request: Request,
  channelId: string,
): Promise<FilePage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const query = validated(FileQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await channelFiles(database, context, query);
};

export const postMessage = async (
  dependencies: MessageDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<Message> => {
  const { database, clock } = dependencies;
  const { userId, sessionId } = await requireSession(database, clock, request);
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
export const readThread = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<MessagePage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  // A deleted root with replies keeps its place in the feed, and its thread with it (D-103 §7).
  const root = await requireMessageById(database, userId, messageId, { deleted: 'include' });
  const query = validated(PageQuery, asPageQuery(new URL(request.url)));
  return await threadReplies(database, root, query);
};

/**
 * `GET /api/messages/:messageId/around` — the feed around a message, for a link to it (D-149). A
 * message deleted, never sent, or in a channel the caller cannot see is the one `404` (D-34).
 */
export const readAround = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<MessageWindow> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  return await messageWindow(database, await requireMessageById(database, userId, messageId));
};

/**
 * `GET /api/messages/:messageId/follow` — whether the caller is told of this thread's replies (D-161).
 * Anybody who can see the root may ask; a deleted root with replies keeps its thread (D-103 §7).
 */
export const readThreadFollow = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
): Promise<ThreadFollow> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const root = await requireMessageById(database, userId, messageId, { deleted: 'include' });
  return await followState(database, root);
};

/**
 * `PUT /api/messages/:messageId/follow` — the caller's own choice about this thread (D-161). Their own,
 * as a save is: open to anybody who can see the root, a member of the channel or not (D-156 §3). Told
 * to nobody else, and not to the caller's other devices — they read it when they open the thread.
 */
export const putThreadFollow = async (
  dependencies: HistoryDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<ThreadFollow> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const input = validated(SetThreadFollowRequest, body);
  const root = await requireMessageById(database, userId, messageId, { deleted: 'include' });
  return await setFollowing(database, clock, root, input.following);
};

/** `POST` and `DELETE /api/messages/:messageId/resolve` — close the thread, or reopen it. */
export const setThreadResolution = async (
  dependencies: HistoryDependencies & ResolveDependencies,
  request: Request,
  messageId: string,
  resolved: boolean,
): Promise<Message> => {
  const { database, clock } = dependencies;
  const { userId, sessionId } = await requireSession(database, clock, request);
  return await setResolved(dependencies, userId, messageId, resolved, sessionId);
};

/** `PATCH /api/messages/:messageId` — the author's new content (D-103). */
export const editMessage = async (
  dependencies: HistoryDependencies & SendDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<Message> => {
  const { database, clock } = dependencies;
  const caller = await requireSession(database, clock, request);
  const input = validated(EditMessageRequest, body);
  return await edit(dependencies, caller, messageId, input.content);
};

/** `DELETE /api/messages/:messageId` — the author, or a workspace admin (D-103 §7). */
export const removeMessage = async (
  dependencies: HistoryDependencies & SendDependencies,
  request: Request,
  messageId: string,
): Promise<void> => {
  const { database, clock } = dependencies;
  const caller = await requireSession(database, clock, request);
  await deleteMessage(dependencies, caller, messageId);
};

/**
 * `GET /api/workspaces/:workspaceId/unresolved` — the open-questions view.
 *
 * One of the two reads D-34 was written about: it spans channels, so it asks the
 * guard which ones the caller can see and reads inside that set and nowhere else.
 */
export const readUnresolved = async (
  dependencies: HistoryDependencies,
  request: Request,
  workspaceId: string,
): Promise<MessagePage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const url = new URL(request.url);
  const channelId = url.searchParams.get('channelId');
  const { channelId: one, ...query } = validated(UnresolvedQuery, {
    ...asPageQuery(url),
    ...(channelId === null ? {} : { channelId }),
  });
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
export const readSearch = async (
  dependencies: HistoryDependencies,
  request: Request,
  workspaceId: string,
): Promise<SearchPage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const url = new URL(request.url);
  const query = asPageQuery(url);
  for (const key of ['q', 'channelId', 'senderId'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = key === 'q' ? value.trim() : value;
  }
  const search = validated(SearchQuery, query);
  return await searchIn(database, context, await visibleChannelIds(database, context), search);
};
