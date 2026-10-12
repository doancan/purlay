/**
 * Every endpoint the client calls, typed by the contract and spelled once.
 *
 * `API.md` is the list and `@purlay/types` the shapes; this is the only file that
 * joins them to a path, so a path that is wrong is wrong in one place and a shape
 * the server changes fails the response check here, not three screens away. Each
 * method returns what the contract says and throws an `ApiError` — it never
 * returns half of a response.
 */
import { Type } from '@sinclair/typebox';
import {
  ChannelList,
  Channel,
  MeResponse,
  Membership,
  Message,
  MessagePage,
  NotificationPage,
  ReactionsResponse,
  ReadChannelResponse,
  ThreadPage,
  UnresolvedPage,
  Workspace,
  WorkspaceMemberList,
  type CreateChannelRequest,
  type CreateWorkspaceRequest,
  type SendMessageRequest,
} from '@purlay/types';
import type { Http, RequestOptions } from './http';

interface PageQuery {
  /** Older than this id (newest first). */
  readonly before?: string | undefined;
  /** Newer than this id (oldest first) — what a continuation after a reconnect asks for. */
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

const Memberships = Type.Array(Membership);

export interface Api {
  readonly me: (signal?: AbortSignal) => Promise<MeResponse>;
  readonly workspaces: (signal?: AbortSignal) => Promise<Membership[]>;
  readonly createWorkspace: (input: CreateWorkspaceRequest) => Promise<Workspace>;
  readonly members: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceMemberList>;

  readonly channels: (workspaceId: string, signal?: AbortSignal) => Promise<ChannelList>;
  readonly createChannel: (workspaceId: string, input: CreateChannelRequest) => Promise<Channel>;
  readonly joinChannel: (channelId: string) => Promise<Channel>;
  /** Brings somebody from the workspace into the channel (D-104); they are told by the server. */
  readonly addChannelMember: (channelId: string, userId: string) => Promise<void>;
  readonly openDirectMessage: (workspaceId: string, userId: string) => Promise<Channel>;
  readonly markRead: (channelId: string, lastReadMessageId: string) => Promise<ReadChannelResponse>;

  readonly messages: (
    channelId: string,
    page?: PageQuery,
    signal?: AbortSignal,
  ) => Promise<MessagePage>;
  readonly send: (channelId: string, input: SendMessageRequest) => Promise<Message>;
  readonly thread: (
    messageId: string,
    page?: PageQuery,
    signal?: AbortSignal,
  ) => Promise<ThreadPage>;
  readonly resolve: (messageId: string) => Promise<Message>;
  readonly reopen: (messageId: string) => Promise<Message>;
  readonly unresolved: (
    workspaceId: string,
    page?: PageQuery,
    signal?: AbortSignal,
  ) => Promise<UnresolvedPage>;
  /** The caller's inbox in one workspace, newest first (D-106). */
  readonly notifications: (
    workspaceId: string,
    page?: { readonly before?: string | undefined },
    signal?: AbortSignal,
  ) => Promise<NotificationPage>;
  readonly react: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  readonly unreact: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  /** The author's new words (D-103); the answer is the message as it now is. */
  readonly editMessage: (messageId: string, content: string) => Promise<Message>;
  readonly deleteMessage: (messageId: string) => Promise<void>;

  readonly signOut: () => Promise<void>;
}

export const createApi = (http: Http): Api => {
  /** What a request needs beyond its path: a body, a query, and the page's wish to abandon it. */
  const options = (extra: RequestOptions = {}, signal?: AbortSignal): RequestOptions => ({
    ...extra,
    ...(signal === undefined ? {} : { signal }),
  });
  const at = (id: string): string => encodeURIComponent(id);

  return {
    me: (signal) => http.request('GET', '/api/me', MeResponse, options({}, signal)),
    workspaces: (signal) =>
      http.request('GET', '/api/workspaces', Memberships, options({}, signal)),
    createWorkspace: (input) =>
      http.request('POST', '/api/workspaces', Workspace, options({ body: input })),
    members: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/members`,
        WorkspaceMemberList,
        options({}, signal),
      ),

    channels: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/channels`,
        ChannelList,
        options({}, signal),
      ),
    createChannel: (workspaceId, input) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/channels`,
        Channel,
        options({ body: input }),
      ),
    addChannelMember: (channelId, userId) =>
      http.send('POST', `/api/channels/${at(channelId)}/members`, options({ body: { userId } })),
    joinChannel: (channelId) =>
      http.request('POST', `/api/channels/${at(channelId)}/join`, Channel, options()),
    openDirectMessage: (workspaceId, userId) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/dms`,
        Channel,
        options({ body: { userId } }),
      ),
    markRead: (channelId, lastReadMessageId) =>
      http.request(
        'PUT',
        `/api/channels/${at(channelId)}/read`,
        ReadChannelResponse,
        options({ body: { lastReadMessageId } }),
      ),

    messages: (channelId, page = {}, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/messages`,
        MessagePage,
        options({ query: { ...page } }, signal),
      ),
    send: (channelId, input) =>
      http.request(
        'POST',
        `/api/channels/${at(channelId)}/messages`,
        Message,
        options({ body: input }),
      ),
    thread: (messageId, page = {}, signal) =>
      http.request(
        'GET',
        `/api/messages/${at(messageId)}/thread`,
        ThreadPage,
        options({ query: { ...page } }, signal),
      ),
    resolve: (messageId) =>
      http.request('POST', `/api/messages/${at(messageId)}/resolve`, Message, options()),
    reopen: (messageId) =>
      http.request('DELETE', `/api/messages/${at(messageId)}/resolve`, Message, options()),
    unresolved: (workspaceId, page = {}, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/unresolved`,
        UnresolvedPage,
        options({ query: { ...page } }, signal),
      ),
    notifications: (workspaceId, page = {}, signal) =>
      http.request(
        'GET',
        '/api/notifications',
        NotificationPage,
        options({ query: { workspaceId, ...page } }, signal),
      ),
    react: (messageId, emoji) =>
      http.request(
        'PUT',
        `/api/messages/${at(messageId)}/reactions/${at(emoji)}`,
        ReactionsResponse,
        options(),
      ),
    unreact: (messageId, emoji) =>
      http.request(
        'DELETE',
        `/api/messages/${at(messageId)}/reactions/${at(emoji)}`,
        ReactionsResponse,
        options(),
      ),

    editMessage: (messageId, content) =>
      http.request(
        'PATCH',
        `/api/messages/${at(messageId)}`,
        Message,
        options({ body: { content } }),
      ),
    deleteMessage: (messageId) => http.send('DELETE', `/api/messages/${at(messageId)}`, options()),
    signOut: () => http.send('POST', '/auth/logout', options()),
  };
};
