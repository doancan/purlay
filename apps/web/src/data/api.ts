import {
  SavedSearch,
  SavedSearchPage,
  type SaveSearchRequest,
  type SetKnowledgeRequest,
  type SearchQuery,
  type UnresolvedQuery,
} from '@purlay/types';
/**
 * Every endpoint the client calls, typed by the contract and spelled once.
 *
 * `API.md` is the list and `@purlay/types` the shapes; this is the only file that
 * joins them to a path, so a path that is wrong is wrong in one place and a shape
 * the server changes fails the response check here, not three screens away. Each
 * method returns what the contract says and throws an `ApiError` — it never
 * returns half of a response.
 */
import { Type, type Static } from '@sinclair/typebox';
import {
  ArchivedChannelList,
  Attachment,
  QuietHoursSetting,
  type SetQuietHoursRequest,
  GitHubAppRedirect,
  GitHubAppStatus,
  GitHubIssueOutcome,
  GitHubRepositoryList,
  GitHubWorkLink,
  type CreateGitHubIssueRequest,
  type LinkGitHubWorkRequest,
  MissedMailSetting,
  type SetMissedMailRequest,
  AuditPage,
  type AuditFilter,
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
  CreatedIncomingWebhook,
  GitHubFeedList,
  IncomingWebhookList,
  GitHubIntegration,
  PinList,
  BookmarkList,
  ChannelBookmark,
  type AddBookmarkRequest,
  Incident,
  IncidentResponse,
  IncidentUpdatePage,
  type ChangeIncidentRequest,
  type DeclareIncidentRequest,
  type SavePostmortemRequest,
  InvitationPage,
  InvitationPreview,
  RetentionSetting,
  ChannelRetention,
  type ChannelRetentionFloor,
  StorageUsage,
  WorkspaceDeletion,
  WorkspaceExport,
  AuthMethods,
  NativeAuthorizeResponse,
  type NativeAuthorizeRequest,
  MySignIn,
  DeviceSessionList,
  PasswordSignInAnswer,
  TwoFactorEnrolment,
  BackupCodes,
  EmailSignInPreview,
  type EmailSignInRequest,
  NotificationPage,
  type NotificationQuery,
  PushKeyResponse,
  SavedIds,
  SavedPage,
  ReactionsResponse,
  SearchPage,
  ReadAllChannelsResponse,
  ReadChannelResponse,
  ThreadFollow,
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
  type ReadThreadRequest,
  type SetThreadFollowRequest,
  type SendMessageRequest,
  type PushLocale,
  Profile,
  type UpdateProfileRequest,
  type PushSubscribeRequest,
  type SavedState,
  type CreateGitHubFeedRequest,
  type CreateIncomingWebhookRequest,
  PresenceSnapshot,
  MessageVersionPage,
  MessageWindow,
} from '@purlay/types';
import type { CreateInvitationRequest } from '@purlay/types';
import type { Http, RequestOptions } from './http';

interface PageQuery {
  /** Older than this id (newest first). */
  readonly before?: string | undefined;
  /** Newer than this id (oldest first) — what a continuation after a reconnect asks for. */
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

const Memberships = Type.Array(Membership);
const WorkspaceExports = Type.Array(WorkspaceExport);

/**
 * `GET /setup/status` (`SetupStatus`, `API.md` §2): whether this server is open to setup, and the address
 * it is configured for. The only setup call the main chunk makes — `/` goes to the wizard on a fresh
 * server — so its schema is here and the wizard's other calls are in the wizard's own chunk.
 */
const SetupStatusAnswer = Type.Object({ open: Type.Boolean(), appUrl: Type.String() });
export type SetupStatusAnswer = Static<typeof SetupStatusAnswer>;

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
  readonly createInvitation: (
    workspaceId: string,
    mail?: CreateInvitationRequest,
  ) => Promise<CreatedInvitation>;
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
  /** An owner's or an admin's: the incoming webhooks a channel has, never their secrets (D-245). */
  readonly incomingWebhooks: (
    channelId: string,
    signal?: AbortSignal,
  ) => Promise<IncomingWebhookList>;
  /** Makes an incoming webhook: the hook, and the path with its secret — once. */
  readonly createIncomingWebhook: (
    channelId: string,
    input: CreateIncomingWebhookRequest,
  ) => Promise<CreatedIncomingWebhook>;
  readonly revokeIncomingWebhook: (channelId: string, webhookId: string) => Promise<void>;
  /** A new secret for the feed, same address; the old one stops working at once. Shown once (#884). */
  readonly regenerateGitHubFeedSecret: (
    channelId: string,
    feedId: string,
  ) => Promise<CreatedGitHubFeed>;
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
  /** The caller leaves the workspace and its channels (D-152). */
  readonly leaveWorkspace: (workspaceId: string) => Promise<void>;
  /** An owner's or an admin's: the administrative trail, newest first, narrowed (D-26, D-222). */
  readonly audit: (
    workspaceId: string,
    filter: AuditFilter,
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
  /** An owner's or an admin's: the archived channels they may bring back (D-232). */
  readonly archivedChannels: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<ArchivedChannelList>;
  /** An owner's or an admin's: an archived channel brought back, as it was (D-232). */
  readonly restoreChannel: (channelId: string) => Promise<void>;
  readonly leaveChannel: (channelId: string) => Promise<void>;
  /** Who is in the channel (D-123). */
  readonly channelMembers: (channelId: string, signal?: AbortSignal) => Promise<ChannelMemberList>;
  /** Brings somebody from the workspace into the channel (D-104); they are told by the server. */
  readonly addChannelMember: (channelId: string, userId: string) => Promise<void>;
  /** Takes somebody out of the channel (D-172); they are told by the server. */
  readonly removeChannelMember: (channelId: string, userId: string) => Promise<void>;
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
  /** "Mark unread from here" (D-212): the position back to just before this message. */
  readonly markUnread: (channelId: string, fromMessageId: string) => Promise<ReadChannelResponse>;
  /** Every channel the caller is in, read to its newest message (D-238). */
  readonly markAllRead: (workspaceId: string) => Promise<ReadAllChannelsResponse>;
  /** A workspace's members online now, for a member (D-136). */
  readonly presence: (workspaceId: string, signal?: AbortSignal) => Promise<PresenceSnapshot>;
  /** What a message said before each edit, newest first (D-135). */
  readonly messageVersions: (
    messageId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<MessageVersionPage>;
  /** The author takes one earlier version out of the history (D-135 §2). */
  readonly removeMessageVersion: (messageId: string, versionId: string) => Promise<void>;
  /** A channel's pins, newest first (D-130). */
  readonly pins: (channelId: string, signal?: AbortSignal) => Promise<PinList>;
  /** A channel's open incident, or its latest; null when it never had one (D-137). */
  readonly incident: (channelId: string, signal?: AbortSignal) => Promise<IncidentResponse>;
  /** Declares one, at the client's id: the same again answers the incident it made (D-137 §5). */
  readonly declareIncident: (channelId: string, input: DeclareIncidentRequest) => Promise<Incident>;
  readonly changeIncident: (
    channelId: string,
    incidentId: string,
    input: ChangeIncidentRequest,
  ) => Promise<Incident>;
  /** Brings somebody in the channel in to respond, or takes them off (D-137 §3). */
  readonly respond: (
    channelId: string,
    incidentId: string,
    userId: string,
    responding: boolean,
  ) => Promise<Incident>;
  /** Saves the postmortem from the version it was edited from (D-137 §5). */
  readonly savePostmortem: (
    channelId: string,
    incidentId: string,
    input: SavePostmortemRequest,
  ) => Promise<Incident>;
  /** An incident's timeline, newest first; older than `before` (D-137 §4). */
  readonly incidentUpdates: (
    channelId: string,
    incidentId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<IncidentUpdatePage>;
  /** Pins a message for its channel, or lets the pin go (D-130). */
  readonly pin: (messageId: string) => Promise<void>;
  readonly unpin: (messageId: string) => Promise<void>;
  /** A channel's bookmarks, oldest first (D-218). */
  readonly bookmarks: (channelId: string, signal?: AbortSignal) => Promise<BookmarkList>;
  /** A member keeps a link at hand; the same address again answers the bookmark already there. */
  readonly addBookmark: (channelId: string, input: AddBookmarkRequest) => Promise<ChannelBookmark>;
  readonly removeBookmark: (channelId: string, bookmarkId: string) => Promise<void>;
  /** A channel's files, newest message first; older than `before`, a file's id (D-129). */
  readonly files: (channelId: string, before?: string, signal?: AbortSignal) => Promise<FilePage>;

  readonly messages: (
    channelId: string,
    page?: PageQuery,
    signal?: AbortSignal,
  ) => Promise<MessagePage>;
  /** One message, for the card a link to it is drawn as (D-217); 404 when it is not the caller's to see. */
  readonly message: (messageId: string, signal?: AbortSignal) => Promise<Message>;
  /** The feed around one message, for a link to it (D-149). */
  readonly messageWindow: (messageId: string, signal?: AbortSignal) => Promise<MessageWindow>;
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
  readonly setKnowledge: (messageId: string, input: SetKnowledgeRequest) => Promise<Message>;
  readonly savedSearches: (
    workspaceId: string,
    before?: string,
    signal?: AbortSignal,
  ) => Promise<SavedSearchPage>;
  readonly saveSearch: (
    workspaceId: string,
    id: string,
    input: SaveSearchRequest,
  ) => Promise<SavedSearch>;
  readonly deleteSearch: (workspaceId: string, id: string) => Promise<void>;
  readonly resolve: (messageId: string) => Promise<Message>;
  readonly reopen: (messageId: string) => Promise<Message>;
  /** The open questions; with `channelId`, that channel's alone (a channel it cannot see is 404). */
  readonly unresolved: (
    workspaceId: string,
    page?: UnresolvedQuery,
    signal?: AbortSignal,
  ) => Promise<UnresolvedPage>;
  /** The caller's inbox in one workspace, newest first (D-106). */
  readonly notifications: (
    workspaceId: string,
    page?: Omit<NotificationQuery, 'workspaceId' | 'before'> & {
      readonly before?: NotificationQuery['before'];
    },
    signal?: AbortSignal,
  ) => Promise<NotificationPage>;
  /** Marks the caller's notifications read: these, or a workspace's up to `before` (D-106). */
  readonly readNotifications: (input: ReadNotificationsRequest) => Promise<void>;
  /** An attachment's bytes as text, read with the session, to be previewed (D-210). */
  readonly attachmentText: (attachmentId: string, signal?: AbortSignal) => Promise<string>;
  /** Reads a thread up to and including a reply: its notifications for the caller (D-147). */
  readonly readThread: (rootId: string, lastReadMessageId: string) => Promise<void>;
  /** Whether the caller is told of new replies in this root's thread (D-161). */
  readonly threadFollow: (rootId: string, signal?: AbortSignal) => Promise<ThreadFollow>;
  /** Follows this root's thread, or lets it go: the caller's own choice (D-161). */
  readonly setThreadFollow: (rootId: string, following: boolean) => Promise<ThreadFollow>;
  /** The words, in the channels the caller can see, newest first (D-105). */
  readonly search: (
    workspaceId: string,
    query: Omit<SearchQuery, 'before'> & { readonly before?: string | undefined },
    signal?: AbortSignal,
  ) => Promise<SearchPage>;
  readonly react: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  readonly unreact: (messageId: string, emoji: string) => Promise<ReactionsResponse>;
  /** The author's new words (D-103); the answer is the message as it now is. */
  readonly editMessage: (messageId: string, content: string) => Promise<Message>;
  readonly deleteMessage: (messageId: string) => Promise<void>;
  /** Throws away one's own upload that was never sent (D-109 §5). */
  readonly discardAttachment: (attachmentId: string) => Promise<void>;

  /** Which ways in this server offers: GitHub always, email when mail is configured (D-138 §6). */
  readonly authMethods: (signal?: AbortSignal) => Promise<AuthMethods>;
  /** Whether the server is open to setup, and the address it is configured for (D-179 §4). */
  readonly setupStatus: (signal?: AbortSignal) => Promise<SetupStatusAnswer>;
  /** The signed-in person says yes to the native application: the address to send the browser to (D-191). */
  readonly authorizeNative: (input: NativeAuthorizeRequest) => Promise<NativeAuthorizeResponse>;
  /** Asks for a sign-in link; `202` whatever the address (D-138 §1). */
  readonly requestEmailSignIn: (input: EmailSignInRequest) => Promise<void>;
  /** Password sign-in, the library's route; a refusal is a `LibraryFailure`. The session cookie is set. */
  /**
   * The library's password sign-in: `signed-in` with the session cookie set, or `second-step` when the account
   * asks for a code too (D-236) — no session yet, only the challenge's cookie. A refusal is a `LibraryFailure`.
   */
  readonly signInWithPassword: (input: {
    email: string;
    password: string;
  }) => Promise<'signed-in' | 'second-step'>;
  /** The second step of a password sign-in: a code from the app, or a backup code; sets the session (D-236). */
  readonly verifySignInCode: (input: { code: string; kind: 'app' | 'backup' }) => Promise<void>;
  /** Starts turning two-step verification on: the password, then the key and the backup codes (D-236). */
  readonly startTwoFactor: (password: string) => Promise<TwoFactorEnrolment>;
  /** Turns it on with the first right code from the app; the session stays the same (D-236). */
  readonly confirmTwoFactor: (code: string) => Promise<void>;
  /** Turns it off, with the password (D-236). */
  readonly stopTwoFactor: (password: string) => Promise<void>;
  /** New backup codes, with the password; the old ones are spent (D-236). */
  readonly newBackupCodes: (password: string) => Promise<BackupCodes>;
  /** Change the caller's password, ending every other session; a refusal is a `LibraryFailure`. */
  readonly changePassword: (input: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<void>;
  /** An invitation's passport, so a newcomer may make an account on an invite-only server (R51). */
  readonly openInvitationPassport: (input: { token: string; email?: string }) => Promise<void>;
  /** The address a link was sent to, without spending it (D-138 §4). */
  readonly previewEmailSignIn: (token: string, signal?: AbortSignal) => Promise<EmailSignInPreview>;
  /** Spends the link; the answer sets the session cookie. */
  readonly consumeEmailSignIn: (token: string) => Promise<void>;
  /** How long the workspace keeps its history; an owner's (D-139 §4). */
  readonly retention: (workspaceId: string, signal?: AbortSignal) => Promise<RetentionSetting>;
  /** An owner's: the workspace's storage used and its quota (D-173). */
  readonly storage: (workspaceId: string, signal?: AbortSignal) => Promise<StorageUsage>;
  readonly setRetention: (
    workspaceId: string,
    retentionDays: number | null,
  ) => Promise<RetentionSetting>;
  /** How long a channel keeps its history beside its workspace's window; an owner's (D-225). */
  readonly channelRetention: (channelId: string, signal?: AbortSignal) => Promise<ChannelRetention>;
  readonly setChannelRetention: (
    channelId: string,
    keepsAtLeast: ChannelRetentionFloor,
  ) => Promise<ChannelRetention>;
  /** An owner's exports of the workspace, newest first; and asking for one, made in the background (D-140). */
  readonly exports: (workspaceId: string, signal?: AbortSignal) => Promise<WorkspaceExport[]>;
  readonly requestExport: (workspaceId: string) => Promise<WorkspaceExport>;
  /** The caller's own exports of their data, newest first; and asking for one (D-241). */
  readonly myExports: (signal?: AbortSignal) => Promise<WorkspaceExport[]>;
  readonly requestMyExport: () => Promise<WorkspaceExport>;
  /** Erases the caller's own account (D-139 §5); the answer clears the session cookie. */
  readonly eraseAccount: (confirm: string) => Promise<void>;
  /** An owner asks for the workspace to be deleted, typing its name (D-242). */
  readonly requestWorkspaceDeletion: (
    workspaceId: string,
    confirm: string,
  ) => Promise<WorkspaceDeletion>;
  /** Any owner takes a workspace's deletion back within its grace period (D-242). */
  readonly cancelWorkspaceDeletion: (workspaceId: string) => Promise<void>;
  /** The ways the caller signs in: their address, and the GitHub account linked to it, if any (D-176, D-179 §5). */
  readonly mySignIn: (signal?: AbortSignal) => Promise<MySignIn>;
  /** Where the caller is signed in, the one used last first (D-193). */
  readonly mySessions: (signal?: AbortSignal) => Promise<DeviceSessionList>;
  /** Ends one of the caller's sessions by its id; one already ended is `SESSION_NOT_FOUND` (D-193 §2). */
  readonly endMySession: (sessionId: string) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Ends every session the person holds, this one with them (D-11). */
  readonly signOutEverywhere: () => Promise<void>;
  /** The server's push key; `PUSH_UNAVAILABLE` where the operator has not switched push on (D-126). */
  readonly pushKey: (signal?: AbortSignal) => Promise<PushKeyResponse>;
  readonly subscribePush: (input: PushSubscribeRequest) => Promise<void>;
  readonly unsubscribePush: (endpoint: string) => Promise<void>;
  /** The language the server writes this person's notifications in. */
  readonly setLocale: (locale: PushLocale) => Promise<void>;
  /** The caller's quiet hours and the profile's time zone they are read in (D-234). */
  readonly quietHours: (signal?: AbortSignal) => Promise<QuietHoursSetting>;
  readonly setQuietHours: (input: SetQuietHoursRequest) => Promise<QuietHoursSetting>;
  /** Whether the caller is emailed about what they missed, and whether it can be offered (D-240). */
  readonly missedMail: (signal?: AbortSignal) => Promise<MissedMailSetting>;
  readonly setMissedMail: (input: SetMissedMailRequest) => Promise<MissedMailSetting>;
  /** The GitHub App in a workspace: whether the server has one, its installation, the caller's own authorization (D-246). */
  readonly githubApp: (workspaceId: string, signal?: AbortSignal) => Promise<GitHubAppStatus>;
  /** What the caller may choose when making an issue: the repositories both they and the App reach (D-246 §2). */
  readonly githubRepositories: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<GitHubRepositoryList>;
  /** Makes an issue from a thread, or says what became of the request with this id (D-246 §2, §4). */
  readonly createGitHubIssue: (
    messageId: string,
    input: CreateGitHubIssueRequest,
  ) => Promise<GitHubIssueOutcome>;
  /** Points a thread at an issue or pull request that exists (D-246 §3). */
  readonly linkGitHubWork: (
    messageId: string,
    input: LinkGitHubWorkRequest,
  ) => Promise<GitHubWorkLink>;
  /** An owner: where GitHub's installation screen is. */
  readonly startGitHubInstallation: (workspaceId: string) => Promise<GitHubAppRedirect>;
  readonly removeGitHubInstallation: (workspaceId: string) => Promise<void>;
  /** The caller, to GitHub's screen for letting Purlay write as them, coming back to `returnTo`. */
  readonly startGitHubAuthorization: (returnTo: string) => Promise<GitHubAppRedirect>;
  readonly forgetGitHubAuthorization: () => Promise<void>;
  /** A letter's stop link, spent without a session (D-240). */
  readonly stopMissedMail: (token: string) => Promise<void>;
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
    createInvitation: (workspaceId, mail) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/invitations`,
        CreatedInvitation,
        options({ body: mail ?? {} }),
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
    regenerateGitHubFeedSecret: (channelId, feedId) =>
      http.request(
        'POST',
        `/api/channels/${at(channelId)}/github-feeds/${at(feedId)}/secret`,
        CreatedGitHubFeed,
        options(),
      ),
    disconnectGitHubFeed: (channelId, feedId) =>
      http.send('DELETE', `/api/channels/${at(channelId)}/github-feeds/${at(feedId)}`, options()),
    incomingWebhooks: (channelId, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/incoming-webhooks`,
        IncomingWebhookList,
        options({}, signal),
      ),
    createIncomingWebhook: (channelId, input) =>
      http.request(
        'POST',
        `/api/channels/${at(channelId)}/incoming-webhooks`,
        CreatedIncomingWebhook,
        options({ body: input }),
      ),
    revokeIncomingWebhook: (channelId, webhookId) =>
      http.send(
        'DELETE',
        `/api/channels/${at(channelId)}/incoming-webhooks/${at(webhookId)}`,
        options(),
      ),
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
    audit: (workspaceId, filter, before, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/audit`,
        AuditPage,
        options({ query: { ...filter, ...(before === undefined ? {} : { before }) } }, signal),
      ),
    removeMember: (workspaceId, userId) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/members/${at(userId)}`, options()),
    leaveWorkspace: (workspaceId) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/membership`, options()),
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
    archivedChannels: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/archived-channels`,
        ArchivedChannelList,
        options({}, signal),
      ),
    restoreChannel: (channelId) =>
      http.send('POST', `/api/channels/${at(channelId)}/restore`, options()),
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
    removeChannelMember: (channelId, userId) =>
      http.send('DELETE', `/api/channels/${at(channelId)}/members/${at(userId)}`, options()),
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
    presence: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/presence`,
        PresenceSnapshot,
        options({}, signal),
      ),
    messageVersions: (messageId, before, signal) =>
      http.request(
        'GET',
        `/api/messages/${at(messageId)}/versions`,
        MessageVersionPage,
        options(before === undefined ? {} : { query: { before } }, signal),
      ),
    removeMessageVersion: (messageId, versionId) =>
      http.send('DELETE', `/api/messages/${at(messageId)}/versions/${at(versionId)}`, options()),
    pins: (channelId, signal) =>
      http.request('GET', `/api/channels/${at(channelId)}/pins`, PinList, options({}, signal)),
    incident: (channelId, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/incident`,
        IncidentResponse,
        options({}, signal),
      ),
    declareIncident: (channelId, input) =>
      http.request(
        'POST',
        `/api/channels/${at(channelId)}/incident`,
        Incident,
        options({ body: input }),
      ),
    changeIncident: (channelId, incidentId, input) =>
      http.request(
        'PATCH',
        `/api/channels/${at(channelId)}/incident/${at(incidentId)}`,
        Incident,
        options({ body: input }),
      ),
    respond: (channelId, incidentId, userId, responding) =>
      http.request(
        responding ? 'PUT' : 'DELETE',
        `/api/channels/${at(channelId)}/incident/${at(incidentId)}/responders/${at(userId)}`,
        Incident,
        options(),
      ),
    savePostmortem: (channelId, incidentId, input) =>
      http.request(
        'PUT',
        `/api/channels/${at(channelId)}/incident/${at(incidentId)}/postmortem`,
        Incident,
        options({ body: input }),
      ),
    incidentUpdates: (channelId, incidentId, before, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/incident/${at(incidentId)}/updates`,
        IncidentUpdatePage,
        options(before === undefined ? {} : { query: { before } }, signal),
      ),
    pin: (messageId) => http.send('PUT', `/api/messages/${at(messageId)}/pin`, options()),
    unpin: (messageId) => http.send('DELETE', `/api/messages/${at(messageId)}/pin`, options()),
    bookmarks: (channelId, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/bookmarks`,
        BookmarkList,
        options({}, signal),
      ),
    addBookmark: (channelId, input) =>
      http.request(
        'POST',
        `/api/channels/${at(channelId)}/bookmarks`,
        ChannelBookmark,
        options({ body: input }),
      ),
    removeBookmark: (channelId, bookmarkId) =>
      http.send('DELETE', `/api/channels/${at(channelId)}/bookmarks/${at(bookmarkId)}`, options()),
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

    markUnread: (channelId, fromMessageId) =>
      http.request(
        'PUT',
        `/api/channels/${at(channelId)}/unread`,
        ReadChannelResponse,
        options({ body: { fromMessageId } }),
      ),
    markAllRead: (workspaceId) =>
      http.request(
        'PUT',
        `/api/workspaces/${at(workspaceId)}/read`,
        ReadAllChannelsResponse,
        options(),
      ),
    messages: (channelId, page = {}, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/messages`,
        MessagePage,
        options({ query: { ...page } }, signal),
      ),
    message: (messageId, signal) =>
      http.request('GET', `/api/messages/${at(messageId)}`, Message, options({}, signal)),
    messageWindow: (messageId, signal) =>
      http.request(
        'GET',
        `/api/messages/${at(messageId)}/around`,
        MessageWindow,
        options({}, signal),
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
    setKnowledge: (id, input) =>
      http.request('PUT', `/api/messages/${at(id)}/knowledge`, Message, options({ body: input })),
    savedSearches: (workspaceId, before, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/saved-searches`,
        SavedSearchPage,
        options({ query: { before } }, signal),
      ),
    saveSearch: (workspaceId, id, input) =>
      http.request(
        'PUT',
        `/api/workspaces/${at(workspaceId)}/saved-searches/${at(id)}`,
        SavedSearch,
        options({ body: input }),
      ),
    deleteSearch: (workspaceId, id) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/saved-searches/${at(id)}`, options()),
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
        options(
          {
            query: {
              workspaceId,
              before: page.before,
              types: page.types,
              limit: page.limit,
              // The server reads it as text; absent is everything (D-106).
              ...(page.unreadOnly === true ? { unreadOnly: 'true' } : {}),
            },
          },
          signal,
        ),
      ),
    attachmentText: (attachmentId, signal) =>
      http.text(`/api/attachments/${at(attachmentId)}`, options({}, signal)),
    readNotifications: (input) =>
      http.send('PUT', '/api/notifications/read', options({ body: input })),
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
        options({ body: { following } satisfies SetThreadFollowRequest }),
      ),
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
    authMethods: (signal) =>
      http.request('GET', '/api/auth/methods', AuthMethods, options({}, signal)),
    setupStatus: (signal) =>
      http.request('GET', '/setup/status', SetupStatusAnswer, options({}, signal)),
    authorizeNative: (input) =>
      http.request(
        'POST',
        '/api/native/authorize',
        NativeAuthorizeResponse,
        options({ body: input }),
      ),
    requestEmailSignIn: (input) => http.send('POST', '/auth/email', options({ body: input })),
    signInWithPassword: async (input) =>
      (await http.libraryRequest('/auth/sign-in/email', PasswordSignInAnswer, input))
        .twoFactorRedirect === true
        ? 'second-step'
        : 'signed-in',
    verifySignInCode: ({ code, kind }) =>
      http.library(
        kind === 'app' ? '/auth/two-factor/verify-totp' : '/auth/two-factor/verify-backup-code',
        { code },
      ),
    startTwoFactor: (password) =>
      http.libraryRequest('/auth/two-factor/enable', TwoFactorEnrolment, { password }),
    confirmTwoFactor: (code) => http.library('/auth/two-factor/verify-totp', { code }),
    stopTwoFactor: (password) => http.library('/auth/two-factor/disable', { password }),
    newBackupCodes: (password) =>
      http.libraryRequest('/auth/two-factor/generate-backup-codes', BackupCodes, { password }),
    changePassword: (input) =>
      http.library('/auth/change-password', { ...input, revokeOtherSessions: true }),
    openInvitationPassport: (input) =>
      http.send('POST', '/api/invitations/passport', options({ body: input })),
    previewEmailSignIn: (token, signal) =>
      http.request(
        'POST',
        '/auth/email/preview',
        EmailSignInPreview,
        options({ body: { token } }, signal),
      ),
    consumeEmailSignIn: (token) =>
      http.send('POST', '/auth/email/consume', options({ body: { token } })),
    retention: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/retention`,
        RetentionSetting,
        options({}, signal),
      ),
    storage: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/storage`,
        StorageUsage,
        options({}, signal),
      ),
    setRetention: (workspaceId, retentionDays) =>
      http.request(
        'PUT',
        `/api/workspaces/${at(workspaceId)}/retention`,
        RetentionSetting,
        options({ body: { retentionDays } }),
      ),
    channelRetention: (channelId, signal) =>
      http.request(
        'GET',
        `/api/channels/${at(channelId)}/retention`,
        ChannelRetention,
        options({}, signal),
      ),
    setChannelRetention: (channelId, keepsAtLeast) =>
      http.request(
        'PUT',
        `/api/channels/${at(channelId)}/retention`,
        ChannelRetention,
        options({ body: { keepsAtLeast } }),
      ),
    exports: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/exports`,
        WorkspaceExports,
        options({}, signal),
      ),
    requestExport: (workspaceId) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/exports`,
        WorkspaceExport,
        options(),
      ),
    myExports: (signal) =>
      http.request('GET', '/api/me/exports', WorkspaceExports, options({}, signal)),
    requestMyExport: () => http.request('POST', '/api/me/exports', WorkspaceExport, options()),
    eraseAccount: (confirm) => http.send('POST', '/api/me/erase', options({ body: { confirm } })),
    requestWorkspaceDeletion: (workspaceId, confirm) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/deletion`,
        WorkspaceDeletion,
        options({ body: { confirm } }),
      ),
    cancelWorkspaceDeletion: (workspaceId) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/deletion`, options()),
    mySignIn: (signal) => http.request('GET', '/api/me/sign-in', MySignIn, options({}, signal)),
    mySessions: (signal) =>
      http.request('GET', '/api/me/sessions', DeviceSessionList, options({}, signal)),
    endMySession: (sessionId) =>
      http.send('DELETE', `/api/me/sessions/${at(sessionId)}`, options()),
    signOut: () => http.send('POST', '/auth/logout', options()),
    signOutEverywhere: () => http.send('POST', '/auth/logout-all', options()),
    pushKey: (signal) => http.request('GET', '/api/push/key', PushKeyResponse, options({}, signal)),
    subscribePush: (input) =>
      http.send('POST', '/api/push/subscriptions', options({ body: input })),
    unsubscribePush: (endpoint) =>
      http.send('POST', '/api/push/subscriptions/remove', options({ body: { endpoint } })),
    setLocale: (locale) => http.send('PUT', '/api/me/locale', options({ body: { locale } })),
    quietHours: (signal) =>
      http.request('GET', '/api/me/quiet-hours', QuietHoursSetting, options({}, signal)),
    setQuietHours: (input) =>
      http.request('PUT', '/api/me/quiet-hours', QuietHoursSetting, options({ body: input })),
    missedMail: (signal) =>
      http.request('GET', '/api/me/missed-mail', MissedMailSetting, options({}, signal)),
    setMissedMail: (input) =>
      http.request('PUT', '/api/me/missed-mail', MissedMailSetting, options({ body: input })),
    stopMissedMail: (token) =>
      http.send('POST', '/api/missed-mail/stop', options({ body: { token } })),
    githubApp: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/github-app`,
        GitHubAppStatus,
        options({}, signal),
      ),
    githubRepositories: (workspaceId, signal) =>
      http.request(
        'GET',
        `/api/workspaces/${at(workspaceId)}/github-repositories`,
        GitHubRepositoryList,
        options({}, signal),
      ),
    createGitHubIssue: (messageId, input) =>
      http.request(
        'POST',
        `/api/messages/${at(messageId)}/github-issue`,
        GitHubIssueOutcome,
        options({ body: input }),
      ),
    linkGitHubWork: (messageId, input) =>
      http.request(
        'POST',
        `/api/messages/${at(messageId)}/github-link`,
        GitHubWorkLink,
        options({ body: input }),
      ),
    startGitHubInstallation: (workspaceId) =>
      http.request(
        'POST',
        `/api/workspaces/${at(workspaceId)}/github-app/installation`,
        GitHubAppRedirect,
        options(),
      ),
    removeGitHubInstallation: (workspaceId) =>
      http.send('DELETE', `/api/workspaces/${at(workspaceId)}/github-app/installation`, options()),
    startGitHubAuthorization: (returnTo) =>
      http.request(
        'POST',
        '/api/github-app/authorization',
        GitHubAppRedirect,
        options({ body: { returnTo } }),
      ),
    forgetGitHubAuthorization: () =>
      http.send('DELETE', '/api/github-app/authorization', options()),
  };
};
