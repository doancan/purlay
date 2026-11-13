// Messages and threads: reading, sending, editing, reacting, uploads and read positions.
import {
  Attachment,
  ChannelCatchUp,
  FollowedThreadsPage,
  Message,
  MessagePage,
  MessageVersionPage,
  MessageWindow,
  ReactionsResponse,
  ReadAllChannelsResponse,
  ReadChannelResponse,
  ThreadFollow,
  ThreadPage,
  UnresolvedPage,
  type CatchUpQuery,
  type FollowedThreadsQuery,
  type ReadThreadRequest,
  type SendMessageRequest,
  type SetKnowledgeRequest,
  type SetThreadFollowRequest,
  type UnresolvedQuery,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options, type PageQuery } from './request';

export interface MessagesApi {
  readonly messages: (
    channelId: string,
    page?: PageQuery,
    signal?: AbortSignal,
    foreground?: boolean,
  ) => Promise<MessagePage>;
  readonly unreads: (
    channelId: string,
    query?: CatchUpQuery,
    signal?: AbortSignal,
  ) => Promise<ChannelCatchUp>;
  /** One message, for the card a link to it is drawn as (D-217); 404 when it is not the caller's to see. */
  readonly message: (messageId: string, signal?: AbortSignal) => Promise<Message>;
  /** The feed around one message, for a link to it (D-149). */
  readonly messageWindow: (
    messageId: string,
    signal?: AbortSignal,
    foreground?: boolean,
  ) => Promise<MessageWindow>;
  readonly send: (
    channelId: string,
    input: SendMessageRequest,
    foreground?: boolean,
  ) => Promise<Message>;
  /** A file's bytes under the attachment id the client chose (D-109 §3). */
  readonly upload: (
    workspaceId: string,
    upload: { readonly id: string; readonly name: string; readonly file: Blob },
    /** Told the share of the file sent so far, from 0 to 1, as it goes (#388). */
    onProgress?: (fraction: number) => void,
  ) => Promise<Attachment>;
  readonly thread: (
    messageId: string,
    page?: PageQuery,
    signal?: AbortSignal,
    foreground?: boolean,
  ) => Promise<ThreadPage>;
  readonly setKnowledge: (messageId: string, input: SetKnowledgeRequest) => Promise<Message>;
  readonly resolve: (messageId: string) => Promise<Message>;
  readonly reopen: (messageId: string) => Promise<Message>;
  /** The open questions; with `channelId`, that channel's alone (a channel it cannot see is 404). */
  readonly unresolved: (
    workspaceId: string,
    page?: UnresolvedQuery,
    signal?: AbortSignal,
  ) => Promise<UnresolvedPage>;
  readonly react: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  readonly unreact: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  /** The author's new words (D-103); the answer is the message as it now is. */
  readonly editMessage: (messageId: string, content: string) => Promise<Message>;
  readonly deleteMessage: (messageId: string) => Promise<void>;
  /** Throws away one's own upload that was never sent (D-109 §5). */
  readonly discardAttachment: (attachmentId: string) => Promise<void>;
  /** An attachment's bytes as text, read with the session, to be previewed (D-210). */
  readonly attachmentText: (attachmentId: string, signal?: AbortSignal) => Promise<string>;
  /** Counted binary bytes for an on-demand reader; every open revalidates the session. */
  readonly attachmentBytes: (
    attachmentId: string,
    maxBytes: number,
    signal?: AbortSignal,
  ) => Promise<Uint8Array<ArrayBuffer>>;
  /** What a message said before each edit, newest first (D-135). */
  readonly messageVersions: (
    messageId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<MessageVersionPage>;
  /** The author takes one earlier version out of the history (D-135 §2). */
  readonly removeMessageVersion: (messageId: string, versionId: string) => Promise<void>;
  readonly markRead: (channelId: string, lastReadMessageId: string) => Promise<ReadChannelResponse>;
  /** "Mark unread from here" (D-212): the position back to just before this message. */
  readonly markUnread: (channelId: string, fromMessageId: string) => Promise<ReadChannelResponse>;
  /** Every channel the caller is in, read to its newest message (D-238). */
  readonly markAllRead: (workspaceId: string) => Promise<ReadAllChannelsResponse>;
  /** Reads a thread up to and including a reply: its notifications for the caller (D-147). */
  readonly readThread: (rootId: string, lastReadMessageId: string) => Promise<void>;
  /** Whether the caller is told of new replies in this root's thread (D-161). */
  readonly threadFollow: (rootId: string, signal?: AbortSignal) => Promise<ThreadFollow>;
  /** Follows this root's thread, or lets it go: the caller's own choice (D-161). */
  readonly setThreadFollow: (rootId: string, following: boolean) => Promise<ThreadFollow>;
  /** The caller's followed roots, including authored and answered conversations without a manual choice. */
  readonly followedThreads: (
    workspaceId: string,
    query?: FollowedThreadsQuery,
    signal?: AbortSignal,
  ) => Promise<FollowedThreadsPage>;
}

export const createMessagesApi = (http: Http): MessagesApi => ({
  messages: (channelId, page = {}, signal, foreground = false) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/messages`,
      MessagePage,
      options({ activity: foreground, query: { ...page } }, signal),
    ),
  unreads: (channelId, query = {}, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/unreads`,
      ChannelCatchUp,
      options({ query: { ...query } }, signal),
    ),
  message: (messageId, signal) =>
    http.request('GET', `/api/messages/${at(messageId)}`, Message, options({}, signal)),
  messageWindow: (messageId, signal, foreground = false) =>
    http.request(
      'GET',
      `/api/messages/${at(messageId)}/around`,
      MessageWindow,
      options({ activity: foreground }, signal),
    ),
  send: (channelId, input, foreground = false) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/messages`,
      Message,
      options({ body: input, activity: foreground }),
    ),
  upload: (workspaceId, { id, name, file }, onProgress) =>
    http.upload(`/api/workspaces/${at(workspaceId)}/uploads`, Attachment, file, {
      query: { id, name },
      activity: true,
      ...(onProgress === undefined
        ? {}
        : {
            onProgress: (sent: number, total: number): void => {
              onProgress(total === 0 ? 1 : sent / total);
            },
          }),
    }),
  thread: (messageId, page = {}, signal, foreground = false) =>
    http.request(
      'GET',
      `/api/messages/${at(messageId)}/thread`,
      ThreadPage,
      options({ activity: foreground, query: { ...page } }, signal),
    ),
  setKnowledge: (id, input) =>
    http.request(
      'PUT',
      `/api/messages/${at(id)}/knowledge`,
      Message,
      options({ activity: true, body: input }),
    ),
  resolve: (messageId) =>
    http.request(
      'POST',
      `/api/messages/${at(messageId)}/resolve`,
      Message,
      options({ activity: true }),
    ),
  reopen: (messageId) =>
    http.request(
      'DELETE',
      `/api/messages/${at(messageId)}/resolve`,
      Message,
      options({ activity: true }),
    ),
  unresolved: (workspaceId, page = {}, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/unresolved`,
      UnresolvedPage,
      options({ query: { ...page } }, signal),
    ),
  react: (messageId, emoji) =>
    http.request(
      'PUT',
      `/api/messages/${at(messageId)}/reactions/${at(emoji)}`,
      ReactionsResponse,
      options({ activity: true }),
    ),
  unreact: (messageId, emoji) =>
    http.request(
      'DELETE',
      `/api/messages/${at(messageId)}/reactions/${at(emoji)}`,
      ReactionsResponse,
      options({ activity: true }),
    ),
  editMessage: (messageId, content) =>
    http.request(
      'PATCH',
      `/api/messages/${at(messageId)}`,
      Message,
      options({ activity: true, body: { content } }),
    ),
  deleteMessage: (messageId) =>
    http.send('DELETE', `/api/messages/${at(messageId)}`, options({ activity: true })),
  discardAttachment: (attachmentId) =>
    http.send('DELETE', `/api/attachments/${at(attachmentId)}`, options()),
  attachmentText: (attachmentId, signal) =>
    http.text(`/api/attachments/${at(attachmentId)}`, options({}, signal)),
  attachmentBytes: (attachmentId, maxBytes, signal) =>
    http.bytes(`/api/attachments/${at(attachmentId)}`, maxBytes, options({}, signal)),
  messageVersions: (messageId, before, signal) =>
    http.request(
      'GET',
      `/api/messages/${at(messageId)}/versions`,
      MessageVersionPage,
      options(before === undefined ? {} : { query: { before } }, signal),
    ),
  removeMessageVersion: (messageId, versionId) =>
    http.send('DELETE', `/api/messages/${at(messageId)}/versions/${at(versionId)}`, options()),
  markRead: (channelId, lastReadMessageId) =>
    http.request(
      'PUT',
      `/api/channels/${at(channelId)}/read`,
      ReadChannelResponse,
      options({ body: { lastReadMessageId } }),
    ),
  markUnread: (channelId, fromMessageId) =>
    http.request(
      'PUT',
      `/api/channels/${at(channelId)}/unread`,
      ReadChannelResponse,
      options({ activity: true, body: { fromMessageId } }),
    ),
  markAllRead: (workspaceId) =>
    http.request(
      'PUT',
      `/api/workspaces/${at(workspaceId)}/read`,
      ReadAllChannelsResponse,
      options({ activity: true }),
    ),
  readThread: (rootId, lastReadMessageId) =>
    http.send(
      'PUT',
      `/api/messages/${at(rootId)}/thread/read`,
      options({ body: { lastReadMessageId } satisfies ReadThreadRequest }),
    ),
  threadFollow: (rootId, signal) =>
    http.request('GET', `/api/messages/${at(rootId)}/follow`, ThreadFollow, options({}, signal)),
  setThreadFollow: (rootId, following) =>
    http.request(
      'PUT',
      `/api/messages/${at(rootId)}/follow`,
      ThreadFollow,
      options({ activity: true, body: { following } satisfies SetThreadFollowRequest }),
    ),
  followedThreads: (workspaceId, query = {}, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/followed-threads`,
      FollowedThreadsPage,
      options(
        {
          query: {
            ...query,
            unreadOnly: query.unreadOnly === undefined ? undefined : String(query.unreadOnly),
          },
        },
        signal,
      ),
    ),
});
