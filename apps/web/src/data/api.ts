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
  Attachment,
  AuditPage,
  ChannelList,
  ChannelMemberList,
  Channel,
  MeResponse,
  Membership,
  Message,
  MessagePage,
  CreatedInvitation,
  DeepWorkResponse,
  FilePage,
  CreatedGitHubFeed,
  GitHubFeedList,
  GitHubIntegration,
  PinList,
  InvitationPage,
  InvitationPreview,
  NotificationPage,
  PushKeyResponse,
  SavedIds,
  SavedPage,
  ReactionsResponse,
  SearchPage,
  ReadChannelResponse,
  ThreadPage,
  UnfurlResponse,
  UnresolvedPage,
  Workspace,
  WorkspaceMember,
  WorkspaceMemberList,
  type UserRole,
  type CreateChannelRequest,
  type UpdateChannelRequest,
  type CreateWorkspaceRequest,
  type NotificationLevel,
  type SetDeepWorkRequest,
  type ReadNotificationsRequest,
  type SendMessageRequest,
  type PushLocale,
  Profile,
  type UpdateProfileRequest,
  type PushSubscribeRequest,
  type SavedState,
  type CreateGitHubFeedRequest,
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
  /** A new name, an owner's or an admin's; the slug stays (D-124). */
  readonly renameWorkspace: (workspaceId: string, name: string) => Promise<Workspace>;
  /** What an invitation's token opens (D-115); the token goes in the body, never the path. */
  readonly previewInvitation: (token: string, signal?: AbortSignal) => Promise<InvitationPreview>;
  readonly acceptInvitation: (token: string) => Promise<Membership>;
  /** An owner's or an admin's: a new link, its token in this answer only. */
  readonly createInvitation: (workspaceId: string) => Promise<CreatedInvitation>;
  readonly invitations: (
    workspaceId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<InvitationPage>;
  readonly revokeInvitation: (workspaceId: string, invitationId: string) => Promise<void>;
  /** An owner's or an admin's: whether the workspace has a GitHub token, never the token (D-23). */
  readonly githubIntegration: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GitHubIntegration>;
  readonly setGitHubToken: (workspaceId: string, token: string) => Promise<void>;
  /** An owner's or an admin's: the repositories a channel hears from, never their secrets (D-134). */
  readonly githubFeeds: (channelId: string, signal?: AbortSignal) => Promise<GitHubFeedList>;
  /** Connects a repository: the feed, the address and the secret GitHub needs — once. */
  readonly connectGitHubFeed: (
    channelId: string,
    input: CreateGitHubFeedRequest,
  ) => Promise<CreatedGitHubFeed>;
  readonly disconnectGitHubFeed: (channelId: string, feedId: string) => Promise<void>;
  readonly removeGitHubToken: (workspaceId: string) => Promise<void>;
  /** A pull request's or an issue's card, read with the workspace's token (D-23, D-112); null for none. */
  readonly unfurl: (
    workspaceId: string,
    url: string,
    signal?: AbortSignal,
  ) => Promise<UnfurlResponse>;
  readonly members: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceMemberList>;
  /** An owner's or an admin's (`ARCHITECTURE.md` §7.4): a member's new role. */
  readonly updateMemberRole: (
    workspaceId: string,
    userId: string,
    role: UserRole,
  ) => Promise<WorkspaceMember>;
  /** Out of the workspace and its channels (D-111). */
  readonly removeMember: (workspaceId: string, userId: string) => Promise<void>;
  /** An owner's or an admin's: the administrative trail, newest first (D-26). */
  readonly audit: (
    workspaceId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<AuditPage>;

  readonly channels: (workspaceId: string, signal?: AbortSignal) => Promise<ChannelList>;
  readonly createChannel: (workspaceId: string, input: CreateChannelRequest) => Promise<Channel>;
  readonly joinChannel: (channelId: string) => Promise<Channel>;
  /** A member's: a new name or topic, answered with the channel as it now is (D-123). */
  readonly updateChannel: (channelId: string, input: UpdateChannelRequest) => Promise<Channel>;
  /** An owner's or an admin's: archived, for everyone (D-123). */
  readonly archiveChannel: (channelId: string) => Promise<void>;
  readonly leaveChannel: (channelId: string) => Promise<void>;
  /** Who is in the channel (D-123). */
  readonly channelMembers: (channelId: string, signal?: AbortSignal) => Promise<ChannelMemberList>;
  /** Brings somebody from the workspace into the channel (D-104); they are told by the server. */
  readonly addChannelMember: (channelId: string, userId: string) => Promise<void>;
  /** The caller's own Deep Work in a workspace (D-108). */
  readonly setDeepWork: (
    workspaceId: string,
    input: SetDeepWorkRequest,
  ) => Promise<DeepWorkResponse>;
  /** What the caller is told about in this channel (D-107). */
  readonly setNotificationLevel: (channelId: string, level: NotificationLevel) => Promise<void>;
  /** Stars a channel the caller is in, or lets the star go (D-132). */
  readonly star: (channelId: string, starred: boolean) => Promise<void>;
  readonly openDirectMessage: (workspaceId: string, userId: string) => Promise<Channel>;
  /** The conversation of the caller and these people, opened or made (D-127). */
  readonly openConversation: (workspaceId: string, userIds: readonly string[]) => Promise<Channel>;
  /** Saves a message for the caller, or moves its save to `state` (D-128). */
  readonly saveMessage: (messageId: string, state?: SavedState) => Promise<void>;
  readonly unsaveMessage: (messageId: string) => Promise<void>;
  readonly savedIds: (workspaceId: string, signal?: AbortSignal) => Promise<SavedIds>;
  readonly saved: (
    workspaceId: string,
    state: SavedState,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<SavedPage>;
  /** The caller's own title, time zone and status line (D-131). */
  readonly updateProfile: (input: UpdateProfileRequest) => Promise<Profile>;
  readonly markRead: (channelId: string, lastReadMessageId: string) => Promise<ReadChannelResponse>;
  /** A channel's pins, newest first (D-130). */
  readonly pins: (channelId: string, signal?: AbortSignal) => Promise<PinList>;
  /** Pins a message for its channel, or lets the pin go (D-130). */
  readonly pin: (messageId: string) => Promise<void>;
  readonly unpin: (messageId: string) => Promise<void>;
  /** A channel's files, newest message first; older than `before`, a file's id (D-129). */
  readonly files: (channelId: string, before?: string, signal?: AbortSignal) => Promise<FilePage>;

  readonly messages: (
    channelId: string,
    page?: PageQuery,
    signal?: AbortSignal,
  ) => Promise<MessagePage>;
  readonly send: (channelId: string, input: SendMessageRequest) => Promise<Message>;
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
  /** Marks the caller's notifications read: these, or a workspace's up to `before` (D-106). */
  readonly readNotifications: (input: ReadNotificationsRequest) => Promise<void>;
  /** The words, in the channels the caller can see, newest first (D-105). */
  readonly search: (
    workspaceId: string,
    query: {
      readonly q: string;
      readonly channelId?: string | undefined;
      readonly before?: string | undefined;
    },
    signal?: AbortSignal,
  ) => Promise<SearchPage>;
  readonly react: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  readonly unreact: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  /** The author's new words (D-103); the answer is the message as it now is. */
  readonly editMessage: (messageId: string, content: string) => Promise<Message>;
  readonly deleteMessage: (messageId: string) => Promise<void>;
  /** Throws away one's own upload that was never sent (D-109 §5). */
  readonly discardAttachment: (attachmentId: string) => Promise<void>;

  readonly signOut: () => Promise<void>;
  /** Ends every session the person holds, this one with them (D-11). */
  readonly signOutEverywhere: () => Promise<void>;
  /** The server's push key; `PUSH_UNAVAILABLE` where the operator has not switched push on (D-126). */
  readonly pushKey: (signal?: AbortSignal) => Promise<PushKeyResponse>;
  readonly subscribePush: (input: PushSubscribeRequest) => Promise<void>;
  readonly unsubscribePush: (endpoint: string) => Promise<void>;
  /** The language the server writes this person's notifications in. */
  readonly setLocale: (locale: PushLocale) => Promise<void>;
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
    renameWorkspace: (workspaceId, name) =>
      http.request(
        'PATCH',
        `/api/workspaces/${at(workspaceId)}`,
        Workspace,
        options({ body: { name } }),
      ),
    previewInvitation: (token, signal) =>
      http.request(
        'POST',
        '/api/invitations/preview',
        InvitationPreview,
        options({ body: { token } }, signal),
      ),
    acceptInvitation: (token) =>
      http.request('POST', '/api/invitations/accept', Membership, options({ body: { token } })),
    createInvitation: (workspaceId) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/invitations`,
        CreatedInvitation,
        options({ body: {} }),
      ),
    invitations: (workspaceId, before, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/invitations`,
        InvitationPage,
        options(before === undefined ? {} : { query: { before } }, signal),
      ),
    unfurl: (workspaceId, url, signal) =>
      http.request(
        'POST',
        '/api/integrations/github/unfurl',
        UnfurlResponse,
        options({ body: { workspaceId, url } }, signal),
      ),
    githubIntegration: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/integrations/github`,
        GitHubIntegration,
        options({}, signal),
      ),
    setGitHubToken: (workspaceId, token) =>
      http.send(
        'PUT',
        `/api/workspaces/${at(workspaceId)}/integrations/github`,
        options({ body: { token } }),
      ),
    removeGitHubToken: (workspaceId) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/integrations/github`, options()),
    githubFeeds: (channelId, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/github-feeds`,
        GitHubFeedList,
        options({}, signal),
      ),
    connectGitHubFeed: (channelId, input) =>
      http.request(
        'POST',
        `/api/channels/${at(channelId)}/github-feeds`,
        CreatedGitHubFeed,
        options({ body: input }),
      ),
    disconnectGitHubFeed: (channelId, feedId) =>
      http.send('DELETE', `/api/channels/${at(channelId)}/github-feeds/${at(feedId)}`, options()),
    revokeInvitation: (workspaceId, invitationId) =>
      http.send(
        'DELETE',
        `/api/workspaces/${at(workspaceId)}/invitations/${at(invitationId)}`,
        options(),
      ),
    updateMemberRole: (workspaceId, userId, role) =>
      http.request(
        'PATCH',
        `/api/workspaces/${at(workspaceId)}/members/${at(userId)}`,
        WorkspaceMember,
        options({ body: { role } }),
      ),
    audit: (workspaceId, before, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/audit`,
        AuditPage,
        options(before === undefined ? {} : { query: { before } }, signal),
      ),
    removeMember: (workspaceId, userId) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/members/${at(userId)}`, options()),
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
    updateChannel: (channelId, input) =>
      http.request('PATCH', `/api/channels/${at(channelId)}`, Channel, options({ body: input })),
    archiveChannel: (channelId) => http.send('DELETE', `/api/channels/${at(channelId)}`, options()),
    leaveChannel: (channelId) =>
      http.send('POST', `/api/channels/${at(channelId)}/leave`, options()),
    channelMembers: (channelId, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/members`,
        ChannelMemberList,
        options({}, signal),
      ),
    addChannelMember: (channelId, userId) =>
      http.send('POST', `/api/channels/${at(channelId)}/members`, options({ body: { userId } })),
    setDeepWork: (workspaceId, input) =>
      http.request(
        'PUT',
        `/api/workspaces/${at(workspaceId)}/deep-work`,
        DeepWorkResponse,
        options({ body: input }),
      ),
    star: (channelId, starred) =>
      http.send(starred ? 'PUT' : 'DELETE', `/api/channels/${at(channelId)}/star`, options()),
    setNotificationLevel: (channelId, level) =>
      http.send(
        'PUT',
        `/api/channels/${at(channelId)}/notification-level`,
        options({ body: { level } }),
      ),
    joinChannel: (channelId) =>
      http.request('POST', `/api/channels/${at(channelId)}/join`, Channel, options()),
    saveMessage: (messageId, state) =>
      http.send(
        'PUT',
        `/api/messages/${at(messageId)}/saved`,
        options({ body: state === undefined ? {} : { state } }),
      ),
    unsaveMessage: (messageId) =>
      http.send('DELETE', `/api/messages/${at(messageId)}/saved`, options()),
    savedIds: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/saved/ids`,
        SavedIds,
        options({}, signal),
      ),
    pins: (channelId, signal) =>
      http.request('GET', `/api/channels/${at(channelId)}/pins`, PinList, options({}, signal)),
    pin: (messageId) => http.send('PUT', `/api/messages/${at(messageId)}/pin`, options()),
    unpin: (messageId) => http.send('DELETE', `/api/messages/${at(messageId)}/pin`, options()),
    updateProfile: (input) =>
      http.request('PATCH', '/api/me/profile', Profile, options({ body: input })),
    files: (channelId, before, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/files`,
        FilePage,
        options(before === undefined ? {} : { query: { before } }, signal),
      ),
    saved: (workspaceId, state, before, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/saved`,
        SavedPage,
        options({ query: before === undefined ? { state } : { state, before } }, signal),
      ),
    openConversation: (workspaceId, userIds) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/conversations`,
        Channel,
        options({ body: { userIds } }),
      ),
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
    upload: (workspaceId, { id, name, file }, onProgress) =>
      http.upload(`/api/workspaces/${at(workspaceId)}/uploads`, Attachment, file, {
        query: { id, name },
        ...(onProgress === undefined
          ? {}
          : {
              onProgress: (sent: number, total: number): void => {
                onProgress(total === 0 ? 1 : sent / total);
              },
            }),
      }),
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
    readNotifications: (input) =>
      http.send('PUT', '/api/notifications/read', options({ body: input })),
    search: (workspaceId, query, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/search`,
        SearchPage,
        options({ query: { ...query } }, signal),
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
    discardAttachment: (attachmentId) =>
      http.send('DELETE', `/api/attachments/${at(attachmentId)}`, options()),
    signOut: () => http.send('POST', '/auth/logout', options()),
    signOutEverywhere: () => http.send('POST', '/auth/logout-all', options()),
    pushKey: (signal) => http.request('GET', '/api/push/key', PushKeyResponse, options({}, signal)),
    subscribePush: (input) =>
      http.send('POST', '/api/push/subscriptions', options({ body: input })),
    unsubscribePush: (endpoint) =>
      http.send('POST', '/api/push/subscriptions/remove', options({ body: { endpoint } })),
    setLocale: (locale) => http.send('PUT', '/api/me/locale', options({ body: { locale } })),
  };
};
