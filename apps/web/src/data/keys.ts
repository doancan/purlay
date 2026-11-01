import type { AuditFilter, QuestionFilters, SearchFilters } from '@purlay/types';
/**
 * The names of the cache's entries, spelled once.
 *
 * A query key is how a socket frame finds what it must update, so the keys are a
 * contract between the screens that read and the code that writes: one function
 * per family, no string built at a call site. The first element is the family and
 * the rest narrow it, so a family can be addressed whole (`['channels']`) when a
 * frame names a channel and not the workspace it is in.
 */
export const keys = {
  me: ['me'] as const,
  quietHours: ['me', 'quiet-hours'] as const,
  /** Whether the caller is emailed about what they missed (D-240). */
  missedMail: ['me', 'missed-mail'] as const,
  /** The ways the caller signs in, and the GitHub account connected (D-176). */
  mySignIn: ['my-sign-in'] as const,
  /** Where the caller is signed in (D-193). */
  mySessions: ['my-sessions'] as const,
  /** Which ways in this server offers (D-138 §6). */
  authMethods: ['auth-methods'] as const,
  /** Whether the server is open to setup (D-179 §4). */
  setupStatus: ['setup-status'] as const,
  /** A sign-in link's address, read before it is spent (D-138 §4). */
  emailSignIn: (token: string) => ['email-sign-in', token] as const,
  members: (workspaceId: string) => ['members', workspaceId] as const,
  channelMembers: (channelId: string) => ['channel-members', channelId] as const,
  channels: (workspaceId: string) => ['channels', workspaceId] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  /**
   * The feed around one message, which a link opens (D-149). Under the channel's own key, so what
   * edits a channel's messages — a reaction, an edit, a channel let go — reaches it too.
   */
  messagesAround: (channelId: string, messageId: string | null) =>
    ['messages', channelId, 'around', messageId] as const,
  thread: (messageId: string) => ['thread', messageId] as const,
  /** Whether the caller follows a root's thread (D-161): theirs alone, so not under `thread`. */
  threadFollow: (rootId: string) => ['thread-follow', rootId] as const,
  /** The workspace's open questions, or one channel's (`UX.md` §2): one prefix, so a change to a thread reaches both. */
  unresolved: (
    workspaceId: string,
    channelId: string | null = null,
    filters: QuestionFilters = {},
  ) =>
    Object.keys(filters).length > 0
      ? (['unresolved', workspaceId, channelId, filters] as const)
      : channelId === null
        ? (['unresolved', workspaceId] as const)
        : (['unresolved', workspaceId, channelId] as const),
  /**
   * A workspace's inbox; `unread` is the same inbox read with `unreadOnly`, and a category (D-208)
   * one more segment — all under the same prefix, so one frame reads every view again.
   */
  notifications: (workspaceId: string, filter?: 'unread', category?: string) => {
    const base =
      filter === undefined
        ? (['notifications', workspaceId] as const)
        : (['notifications', workspaceId, filter] as const);
    return category === undefined ? base : ([...base, category] as const);
  },
  /**
   * A channel's new messages past a read position (D-216), keyed by the position and the count: read
   * elsewhere or added to, it is asked again.
   */
  unreads: (channelId: string, position: string | null, count: number) =>
    ['unreads', channelId, position ?? 'start', count] as const,
  /** One message, read for the card a link to it is drawn as (D-217). */
  message: (messageId: string) => ['message', messageId] as const,
  /** What one person sent in a workspace, newest first (D-215): search narrowed to them. */
  sent: (workspaceId: string, userId: string) => ['sent', workspaceId, userId] as const,
  /** An attachment's words, read to preview it (D-210): a file never changes, so it is read once. */
  attachmentText: (attachmentId: string) => ['attachment-text', attachmentId] as const,
  /** The inbox panel's one page of a category (D-208): under the inbox's prefix, as every view is. */
  notificationsPanel: (workspaceId: string, category: string) =>
    ['notifications', workspaceId, 'panel', category] as const,
  /** The inbox's newest page, read when an open tab in the background tells of one (D-148). */
  newestNotifications: (workspaceId: string) => ['notifications', workspaceId, 'newest'] as const,
  search: (
    workspaceId: string,
    words: string,
    channelId: string | null,
    authorId: string | null,
    filters: SearchFilters = {},
  ) =>
    Object.keys(filters).length === 0
      ? (['search', workspaceId, words, channelId, authorId] as const)
      : (['search', workspaceId, words, channelId, authorId, filters] as const),
  savedSearches: (workspaceId: string) => ['saved-searches', workspaceId] as const,
  invitation: (token: string) => ['invitation', token] as const,
  invitations: (workspaceId: string) => ['invitations', workspaceId] as const,
  archivedChannels: (workspaceId: string) => ['archived-channels', workspaceId] as const,
  githubIntegration: (workspaceId: string) => ['github-integration', workspaceId] as const,
  githubApp: (workspaceId: string) => ['github-app', workspaceId] as const,
  githubRepositories: (workspaceId: string) => ['github-repositories', workspaceId] as const,
  /** A channel's repository feeds, an owner's or an admin's to read (D-134). */
  githubFeeds: (channelId: string) => ['github-feeds', channelId] as const,
  incomingWebhooks: (channelId: string) => ['incoming-webhooks', channelId] as const,
  /** Who among a workspace's members is online, as read at an epoch (D-136). */
  presence: (workspaceId: string, epoch: number) => ['presence', workspaceId, epoch] as const,
  /** What one message said before each edit (D-135). */
  messageVersions: (messageId: string) => ['message-versions', messageId] as const,
  /** The trail as narrowed (D-222); every filter of a workspace under the one prefix. */
  audit: (workspaceId: string, filter: AuditFilter) => ['audit', workspaceId, filter] as const,
  /** How long a workspace keeps its history, an owner's to read (D-139 §4). */
  retention: (workspaceId: string) => ['retention', workspaceId] as const,
  /** How long a channel keeps its history beside its workspace's, an owner's to read (D-225). */
  channelRetention: (channelId: string) => ['channel-retention', channelId] as const,
  storage: (workspaceId: string) => ['storage', workspaceId] as const,
  /** An owner's own exports of a workspace (D-140). */
  exports: (workspaceId: string) => ['exports', workspaceId] as const,
  /** The caller's own exports of their data (D-241): the person's, in no workspace. */
  myExports: ['my-exports'] as const,
  unfurl: (workspaceId: string, url: string) => ['unfurl', workspaceId, url] as const,
  pushKey: ['push-key'] as const,
  /** Every view of a person's saved messages in a workspace: the ids, and each state's pages. */
  saved: (workspaceId: string) => ['saved', workspaceId] as const,
  /** A channel's files, every page (D-129). */
  files: (channelId: string) => ['files', channelId] as const,
  /** A channel's pins: the list, and the ids that mark them (D-130). */
  pins: (channelId: string) => ['pins', channelId] as const,
  /** A channel's bookmarks, under its header (D-218). */
  bookmarks: (channelId: string) => ['bookmarks', channelId] as const,
  /** A channel's incident, and its timeline under it (D-137). */
  incident: (channelId: string) => ['incident', channelId] as const,
} as const;

/** The families, for the code that addresses one of them whole. */
export const families = {
  channels: ['channels'] as const,
  messages: ['messages'] as const,
  thread: ['thread'] as const,
  unresolved: ['unresolved'] as const,
  notifications: ['notifications'] as const,
  pins: ['pins'] as const,
  incident: ['incident'] as const,
  members: ['members'] as const,
} as const;
