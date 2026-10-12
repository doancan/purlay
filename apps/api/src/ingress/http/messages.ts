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
  PageQuery,
  SearchQuery,
  type SearchPage,
  SendMessageRequest,
  type Message,
  type MessagePage,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireChannelById, requireMessageById } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { visibleChannelIds } from '../../platform/channels';
import { messageHistory, send, type SendDependencies } from '../../modules/messages/messages';
import { edit } from '../../modules/messages/edit';
import { deleteMessage } from '../../modules/messages/delete';
import {
  setResolved,
  threadReplies,
  unresolvedIn,
  type ResolveDependencies,
} from '../../modules/messages/threads';
import { searchIn } from '../../modules/search/search';
import { requireSession } from './session';
import { validated } from './validate';

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
  const query = validated(PageQuery, asPageQuery(new URL(request.url)));
  return await unresolvedIn(database, context, await visibleChannelIds(database, context), query);
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
  for (const key of ['q', 'channelId'] as const) {
    const value = url.searchParams.get(key);
    if (value !== null) query[key] = key === 'q' ? value.trim() : value;
  }
  const search = validated(SearchQuery, query);
  return await searchIn(database, context, await visibleChannelIds(database, context), search);
};
