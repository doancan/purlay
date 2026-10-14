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
  members: (workspaceId: string) => ['members', workspaceId] as const,
  channelMembers: (channelId: string) => ['channel-members', channelId] as const,
  channels: (workspaceId: string) => ['channels', workspaceId] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  thread: (messageId: string) => ['thread', messageId] as const,
  unresolved: (workspaceId: string) => ['unresolved', workspaceId] as const,
  notifications: (workspaceId: string) => ['notifications', workspaceId] as const,
  search: (workspaceId: string, words: string, channelId: string | null) =>
    ['search', workspaceId, words, channelId] as const,
  invitation: (token: string) => ['invitation', token] as const,
  invitations: (workspaceId: string) => ['invitations', workspaceId] as const,
  githubIntegration: (workspaceId: string) => ['github-integration', workspaceId] as const,
  /** A channel's repository feeds, an owner's or an admin's to read (D-134). */
  githubFeeds: (channelId: string) => ['github-feeds', channelId] as const,
  /** Who among a workspace's members is online, as read at an epoch (D-136). */
  presence: (workspaceId: string, epoch: number) => ['presence', workspaceId, epoch] as const,
  /** What one message said before each edit (D-135). */
  messageVersions: (messageId: string) => ['message-versions', messageId] as const,
  audit: (workspaceId: string) => ['audit', workspaceId] as const,
  unfurl: (workspaceId: string, url: string) => ['unfurl', workspaceId, url] as const,
  pushKey: ['push-key'] as const,
  /** Every view of a person's saved messages in a workspace: the ids, and each state's pages. */
  saved: (workspaceId: string) => ['saved', workspaceId] as const,
  /** A channel's files, every page (D-129). */
  files: (channelId: string) => ['files', channelId] as const,
  /** A channel's pins: the list, and the ids that mark them (D-130). */
  pins: (channelId: string) => ['pins', channelId] as const,
} as const;

/** The families, for the code that addresses one of them whole. */
export const families = {
  channels: ['channels'] as const,
  messages: ['messages'] as const,
  thread: ['thread'] as const,
  unresolved: ['unresolved'] as const,
  notifications: ['notifications'] as const,
  pins: ['pins'] as const,
  members: ['members'] as const,
} as const;
