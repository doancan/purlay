/**
 * The endpoint table: which routes a client that is not the browser's own may call, what each takes and what
 * each answers (D-192).
 *
 * `API.md` says which endpoints exist and the handlers validate what they are given, but nothing joined the two
 * to a shape a client could be generated from: a handler takes `body: unknown` and checks it, so there is no
 * route registry carrying schemas to derive one from. This is that join, authored once beside the schemas.
 *
 * **Bound to both truths by `scripts/endpoints.test.ts`**: every entry is a route the application registers and
 * a row of `API.md`, every schema it names is one this package exports (so a client can give it a name), and the
 * integration test `endpoints.integration.test.ts` calls each against a real server and holds the answer to the
 * schema — a response the table does not describe is a failure, not a pass. A route that is not here is one a
 * generated client cannot spell; the table grows with what the macOS application needs (`OVERVIEW.md`).
 *
 * Failures are not repeated per route: every non-success answer is the one envelope (`ErrorResponse`), whose
 * `code` is `ErrorCode` and whose status is `ERROR_STATUS`.
 */
import type { TSchema } from '@sinclair/typebox';
import {
  AddChannelMemberRequest,
  AuthMethods,
  ChannelList,
  ChangesQuery,
  ChangePage,
  ChannelMemberList,
  ClientInfo,
  CreateChannelRequest,
  CreateDirectMessageRequest,
  DeepWorkResponse,
  DeviceSessionList,
  EditMessageRequest,
  ExternalImageQuery,
  FilePage,
  FileQuery,
  MembershipList,
  MeResponse,
  MessagePage,
  MessageVersionPage,
  MessageWindow,
  NativeAuthorizeRequest,
  NativeAuthorizeResponse,
  NativeTokenRequest,
  NotificationPage,
  NotificationQuery,
  OlderPageQuery,
  OpenConversationRequest,
  PageQuery,
  PinList,
  BookmarkList,
  ChannelBookmark,
  AddBookmarkRequest,
  PresenceSnapshot,
  ReactionsResponse,
  ReadChannelRequest,
  MarkUnreadRequest,
  ReadChannelResponse,
  ReadNotificationsRequest,
  ReadThreadRequest,
  SaveMessageRequest,
  SavedIds,
  SavedPage,
  SavedQuery,
  SetKnowledgeRequest,
  SaveSearchRequest,
  SavedSearch,
  SavedSearchPage,
  SearchPage,
  SearchQuery,
  SendMessageRequest,
  SetDeepWorkRequest,
  SetNotificationLevelRequest,
  SetThreadFollowRequest,
  ThreadFollow,
  UnfurlRequest,
  UnfurlResponse,
  UnresolvedPage,
  UnresolvedQuery,
  UploadQuery,
  WorkspaceMemberList,
} from './api';
import { Attachment, Channel, Message, Workspace } from './models';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface EndpointSpec {
  /** The operation's name: one word, lower camel case, what a client names its method. */
  readonly id: string;
  readonly method: HttpMethod;
  /** As the router spells it, `:param` for a path parameter (`API.md` rows spell it so too). */
  readonly path: string;
  /** `session`: the cookie, or the application's own once it has one. `none`: nobody is signed in yet. */
  readonly auth: 'session' | 'none';
  readonly query?: TSchema;
  /** A JSON body's schema, or `octet-stream` for an upload's raw bytes. */
  readonly body?: TSchema | 'octet-stream';
  /**
   * The successes, by status: a schema for a JSON body, `null` for none, `binary` for bytes. More than one
   * where the route says whether it made something (`201`) or found it already there (`200`).
   */
  readonly responses: Readonly<Record<number, TSchema | null | 'binary'>>;
}

const read = <T extends EndpointSpec>(spec: T): T => spec;

export const ENDPOINTS = [
  // ── Before anybody is signed in, and the end of a session
  read({
    id: 'getClientInfo',
    method: 'GET',
    path: '/api/client',
    auth: 'none',
    responses: { 200: ClientInfo },
  }),
  read({
    id: 'nativeAuthorize',
    method: 'POST',
    path: '/api/native/authorize',
    auth: 'session',
    body: NativeAuthorizeRequest,
    responses: { 200: NativeAuthorizeResponse },
  }),
  read({
    id: 'nativeToken',
    method: 'POST',
    path: '/api/native/token',
    auth: 'none',
    body: NativeTokenRequest,
    responses: { 204: null },
  }),
  read({
    id: 'logout',
    method: 'POST',
    path: '/auth/logout',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'logoutEverywhere',
    method: 'POST',
    path: '/auth/logout-all',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'listMySessions',
    method: 'GET',
    path: '/api/me/sessions',
    auth: 'session',
    responses: { 200: DeviceSessionList },
  }),
  read({
    id: 'endMySession',
    method: 'DELETE',
    path: '/api/me/sessions/:sessionId',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'getAuthMethods',
    method: 'GET',
    path: '/api/auth/methods',
    auth: 'none',
    responses: { 200: AuthMethods },
  }),

  // ── The person, and their workspaces
  read({
    id: 'getMe',
    method: 'GET',
    path: '/api/me',
    auth: 'session',
    responses: { 200: MeResponse },
  }),
  read({
    id: 'listWorkspaces',
    method: 'GET',
    path: '/api/workspaces',
    auth: 'session',
    responses: { 200: MembershipList },
  }),
  read({
    id: 'getWorkspace',
    method: 'GET',
    path: '/api/workspaces/:workspaceId',
    auth: 'session',
    responses: { 200: Workspace },
  }),
  read({
    id: 'listWorkspaceMembers',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/members',
    auth: 'session',
    responses: { 200: WorkspaceMemberList },
  }),
  read({
    id: 'getPresence',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/presence',
    auth: 'session',
    responses: { 200: PresenceSnapshot },
  }),
  read({
    id: 'setDeepWork',
    method: 'PUT',
    path: '/api/workspaces/:workspaceId/deep-work',
    auth: 'session',
    body: SetDeepWorkRequest,
    responses: { 200: DeepWorkResponse },
  }),

  // ── Channels and conversations
  read({
    id: 'listChannels',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/channels',
    auth: 'session',
    responses: { 200: ChannelList },
  }),
  read({
    id: 'createChannel',
    method: 'POST',
    path: '/api/workspaces/:workspaceId/channels',
    auth: 'session',
    body: CreateChannelRequest,
    responses: { 201: Channel },
  }),
  read({
    id: 'openConversation',
    method: 'POST',
    path: '/api/workspaces/:workspaceId/conversations',
    auth: 'session',
    body: OpenConversationRequest,
    responses: { 200: Channel, 201: Channel },
  }),
  read({
    id: 'openDirectMessage',
    method: 'POST',
    path: '/api/workspaces/:workspaceId/dms',
    auth: 'session',
    body: CreateDirectMessageRequest,
    responses: { 200: Channel, 201: Channel },
  }),
  read({
    id: 'getChannel',
    method: 'GET',
    path: '/api/channels/:channelId',
    auth: 'session',
    responses: { 200: Channel },
  }),
  read({
    id: 'joinChannel',
    method: 'POST',
    path: '/api/channels/:channelId/join',
    auth: 'session',
    responses: { 200: Channel },
  }),
  read({
    id: 'leaveChannel',
    method: 'POST',
    path: '/api/channels/:channelId/leave',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'listChannelMembers',
    method: 'GET',
    path: '/api/channels/:channelId/members',
    auth: 'session',
    responses: { 200: ChannelMemberList },
  }),
  read({
    id: 'addChannelMember',
    method: 'POST',
    path: '/api/channels/:channelId/members',
    auth: 'session',
    body: AddChannelMemberRequest,
    responses: { 204: null },
  }),
  read({
    id: 'markChannelRead',
    method: 'PUT',
    path: '/api/channels/:channelId/read',
    auth: 'session',
    body: ReadChannelRequest,
    responses: { 200: ReadChannelResponse },
  }),
  read({
    id: 'markChannelUnread',
    method: 'PUT',
    path: '/api/channels/:channelId/unread',
    auth: 'session',
    body: MarkUnreadRequest,
    responses: { 200: ReadChannelResponse },
  }),
  read({
    id: 'starChannel',
    method: 'PUT',
    path: '/api/channels/:channelId/star',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'unstarChannel',
    method: 'DELETE',
    path: '/api/channels/:channelId/star',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'setNotificationLevel',
    method: 'PUT',
    path: '/api/channels/:channelId/notification-level',
    auth: 'session',
    body: SetNotificationLevelRequest,
    responses: { 204: null },
  }),
  read({
    id: 'listPins',
    method: 'GET',
    path: '/api/channels/:channelId/pins',
    auth: 'session',
    responses: { 200: PinList },
  }),
  read({
    id: 'listBookmarks',
    method: 'GET',
    path: '/api/channels/:channelId/bookmarks',
    auth: 'session',
    responses: { 200: BookmarkList },
  }),
  read({
    id: 'addBookmark',
    method: 'POST',
    path: '/api/channels/:channelId/bookmarks',
    auth: 'session',
    body: AddBookmarkRequest,
    responses: { 201: ChannelBookmark },
  }),
  read({
    id: 'removeBookmark',
    method: 'DELETE',
    path: '/api/channels/:channelId/bookmarks/:bookmarkId',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'listFiles',
    method: 'GET',
    path: '/api/channels/:channelId/files',
    auth: 'session',
    query: FileQuery,
    responses: { 200: FilePage },
  }),

  // ── Messages
  read({
    id: 'listMessages',
    method: 'GET',
    path: '/api/channels/:channelId/messages',
    auth: 'session',
    query: PageQuery,
    responses: { 200: MessagePage },
  }),
  read({
    id: 'listChanges',
    method: 'GET',
    path: '/api/channels/:channelId/changes',
    auth: 'session',
    query: ChangesQuery,
    responses: { 200: ChangePage },
  }),
  read({
    id: 'sendMessage',
    method: 'POST',
    path: '/api/channels/:channelId/messages',
    auth: 'session',
    body: SendMessageRequest,
    responses: { 201: Message },
  }),
  read({
    id: 'getMessage',
    method: 'GET',
    path: '/api/messages/:messageId',
    auth: 'session',
    responses: { 200: Message },
  }),
  read({
    id: 'getMessagesAround',
    method: 'GET',
    path: '/api/messages/:messageId/around',
    auth: 'session',
    responses: { 200: MessageWindow },
  }),
  read({
    id: 'editMessage',
    method: 'PATCH',
    path: '/api/messages/:messageId',
    auth: 'session',
    body: EditMessageRequest,
    responses: { 200: Message },
  }),
  read({
    id: 'deleteMessage',
    method: 'DELETE',
    path: '/api/messages/:messageId',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'listMessageVersions',
    method: 'GET',
    path: '/api/messages/:messageId/versions',
    auth: 'session',
    query: OlderPageQuery,
    responses: { 200: MessageVersionPage },
  }),
  read({
    id: 'setKnowledge',
    method: 'PUT',
    path: '/api/messages/:messageId/knowledge',
    auth: 'session',
    body: SetKnowledgeRequest,
    responses: { 200: Message },
  }),
  read({
    id: 'listSavedSearches',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/saved-searches',
    auth: 'session',
    query: OlderPageQuery,
    responses: { 200: SavedSearchPage },
  }),
  read({
    id: 'saveSearch',
    method: 'PUT',
    path: '/api/workspaces/:workspaceId/saved-searches/:searchId',
    auth: 'session',
    body: SaveSearchRequest,
    responses: { 200: SavedSearch },
  }),
  read({
    id: 'deleteSavedSearch',
    method: 'DELETE',
    path: '/api/workspaces/:workspaceId/saved-searches/:searchId',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'getThread',
    method: 'GET',
    path: '/api/messages/:messageId/thread',
    auth: 'session',
    query: PageQuery,
    responses: { 200: MessagePage },
  }),
  read({
    id: 'markThreadRead',
    method: 'PUT',
    path: '/api/messages/:messageId/thread/read',
    auth: 'session',
    body: ReadThreadRequest,
    responses: { 204: null },
  }),
  read({
    id: 'resolveThread',
    method: 'POST',
    path: '/api/messages/:messageId/resolve',
    auth: 'session',
    responses: { 200: Message },
  }),
  read({
    id: 'reopenThread',
    method: 'DELETE',
    path: '/api/messages/:messageId/resolve',
    auth: 'session',
    responses: { 200: Message },
  }),
  read({
    id: 'getThreadFollow',
    method: 'GET',
    path: '/api/messages/:messageId/follow',
    auth: 'session',
    responses: { 200: ThreadFollow },
  }),
  read({
    id: 'setThreadFollow',
    method: 'PUT',
    path: '/api/messages/:messageId/follow',
    auth: 'session',
    body: SetThreadFollowRequest,
    responses: { 200: ThreadFollow },
  }),
  read({
    id: 'putReaction',
    method: 'PUT',
    path: '/api/messages/:messageId/reactions/:emoji',
    auth: 'session',
    responses: { 200: ReactionsResponse },
  }),
  read({
    id: 'deleteReaction',
    method: 'DELETE',
    path: '/api/messages/:messageId/reactions/:emoji',
    auth: 'session',
    responses: { 200: ReactionsResponse },
  }),
  read({
    id: 'pinMessage',
    method: 'PUT',
    path: '/api/messages/:messageId/pin',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'unpinMessage',
    method: 'DELETE',
    path: '/api/messages/:messageId/pin',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'saveMessage',
    method: 'PUT',
    path: '/api/messages/:messageId/saved',
    auth: 'session',
    body: SaveMessageRequest,
    responses: { 204: null },
  }),
  read({
    id: 'unsaveMessage',
    method: 'DELETE',
    path: '/api/messages/:messageId/saved',
    auth: 'session',
    responses: { 204: null },
  }),

  // ── What needs the person, and what they kept
  read({
    id: 'listUnresolved',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/unresolved',
    auth: 'session',
    query: UnresolvedQuery,
    responses: { 200: UnresolvedPage },
  }),
  read({
    id: 'listSaved',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/saved',
    auth: 'session',
    query: SavedQuery,
    responses: { 200: SavedPage },
  }),
  read({
    id: 'listSavedIds',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/saved/ids',
    auth: 'session',
    responses: { 200: SavedIds },
  }),
  read({
    id: 'searchMessages',
    method: 'GET',
    path: '/api/workspaces/:workspaceId/search',
    auth: 'session',
    query: SearchQuery,
    responses: { 200: SearchPage },
  }),
  read({
    id: 'listNotifications',
    method: 'GET',
    path: '/api/notifications',
    auth: 'session',
    query: NotificationQuery,
    responses: { 200: NotificationPage },
  }),
  read({
    id: 'markNotificationsRead',
    method: 'PUT',
    path: '/api/notifications/read',
    auth: 'session',
    body: ReadNotificationsRequest,
    responses: { 204: null },
  }),

  // ── Files, pictures and cards
  read({
    id: 'uploadFile',
    method: 'POST',
    path: '/api/workspaces/:workspaceId/uploads',
    auth: 'session',
    query: UploadQuery,
    body: 'octet-stream',
    responses: { 200: Attachment, 201: Attachment },
  }),
  read({
    id: 'downloadAttachment',
    method: 'GET',
    path: '/api/attachments/:attachmentId',
    auth: 'session',
    responses: { 200: 'binary' },
  }),
  read({
    id: 'downloadAttachmentThumbnail',
    method: 'GET',
    path: '/api/attachments/:attachmentId/thumbnail',
    auth: 'session',
    responses: { 200: 'binary' },
  }),
  read({
    id: 'discardAttachment',
    method: 'DELETE',
    path: '/api/attachments/:attachmentId',
    auth: 'session',
    responses: { 204: null },
  }),
  read({
    id: 'fetchExternalImage',
    method: 'GET',
    path: '/api/images',
    auth: 'session',
    query: ExternalImageQuery,
    responses: { 200: 'binary' },
  }),
  read({
    id: 'unfurlGitHubLink',
    method: 'POST',
    path: '/api/integrations/github/unfurl',
    auth: 'session',
    body: UnfurlRequest,
    responses: { 200: UnfurlResponse },
  }),
] as const satisfies readonly EndpointSpec[];

export type EndpointId = (typeof ENDPOINTS)[number]['id'];
