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
  channels: (workspaceId: string) => ['channels', workspaceId] as const,
  messages: (channelId: string) => ['messages', channelId] as const,
  thread: (messageId: string) => ['thread', messageId] as const,
  unresolved: (workspaceId: string) => ['unresolved', workspaceId] as const,
  notifications: (workspaceId: string) => ['notifications', workspaceId] as const,
} as const;

/** The families, for the code that addresses one of them whole. */
export const families = {
  channels: ['channels'] as const,
  messages: ['messages'] as const,
  thread: ['thread'] as const,
  unresolved: ['unresolved'] as const,
  notifications: ['notifications'] as const,
} as const;
