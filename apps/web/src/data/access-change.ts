/** Forget content whose previous access can no longer be trusted, before asking for it again. */
import type { QueryClient } from '@tanstack/react-query';
import type { Channel, Message, MeResponse, WorkspaceAccess } from '@purlay/types';
import type { FeedPages } from './queries';
import { families, keys } from './keys';
import { advanceAccessRevision, invalidateAccess } from './access-revision';

const WORKSPACE_CONTENT = new Set<string>([
  families.saved[0],
  families.followedThreads[0],
  families.unresolved[0],
  families.notifications[0],
  families.inbox[0],
  families.search[0],
  families.shared[0],
  families.channels[0],
  families.members[0],
  keys.issues('')[0],
  keys.sent('', '')[0],
  keys.unfurl('', '')[0],
]);
const CHANNEL_CONTENT = new Set<string>([
  families.messages[0],
  families.files[0],
  families.pins[0],
  families.webLinkPreviews[0],
  families.unreads[0],
  families.incident[0],
  keys.channelMembers('')[0],
  keys.bookmarks('')[0],
]);
const MESSAGE_CONTENT = new Set<string>([
  families.thread[0],
  families.messageVersions[0],
  keys.threadFollow('')[0],
  keys.message('')[0],
]);

/** Missing or conflicting ownership is uncertain, never evidence of a different workspace. */
const remember = (
  owners: Map<string, string | undefined>,
  id: string,
  owner: string | undefined,
): void => {
  owners.set(id, owners.has(id) && owners.get(id) !== owner ? undefined : owner);
};

/** Cache ownership is only a retention hint. Fresh server guards remain the authority. */
const resetContent = (
  client: QueryClient,
  scope: { readonly workspaceId: string } | { readonly channelIds: ReadonlySet<string> },
  refetch = true,
): void => {
  const channelOwners = new Map<string, string | undefined>();
  const messageOwners = new Map<string, string | undefined>();
  const attachmentOwners = new Map<string, string | undefined>();
  // Build the complete index first: resetting a feed must not erase the ownership of its cards.
  for (const [, channels] of client.getQueriesData<Channel[]>({ queryKey: families.channels }))
    for (const channel of channels ?? []) remember(channelOwners, channel.id, channel.workspaceId);
  const messageSeen = (message: Message): void => {
    remember(messageOwners, message.id, message.channelId);
    if (message.parentId !== null) remember(messageOwners, message.parentId, message.channelId);
    for (const attachment of message.attachments)
      remember(attachmentOwners, attachment.id, message.channelId);
  };
  for (const [, message] of client.getQueriesData<Message>({ queryKey: [keys.message('')[0]] }))
    if (message !== undefined) messageSeen(message);
  for (const family of [families.messages, families.thread])
    for (const [, feed] of client.getQueriesData<FeedPages>({ queryKey: family }))
      for (const page of feed?.pages ?? []) {
        if (page.target !== undefined) messageSeen(page.target);
        for (const message of page.data) messageSeen(message);
      }
  const affectedWorkspaces = new Set<string>();
  let unknownWorkspace = false;
  if ('channelIds' in scope)
    for (const id of scope.channelIds) {
      const owner = channelOwners.get(id);
      if (owner === undefined) unknownWorkspace = true;
      else affectedWorkspaces.add(owner);
    }
  const affectedChannel = (channelId: string | undefined): boolean => {
    if (channelId === undefined) return true;
    if ('channelIds' in scope) return scope.channelIds.has(channelId);
    const owner = channelOwners.get(channelId);
    return owner === undefined || owner === scope.workspaceId;
  };
  // Reset cancels old in-flight reads and synchronously removes data from active observers too.
  // The engine's independent pending-send store is deliberately outside this cache.
  const affected = client.getQueryCache().findAll({
    predicate: (query) => {
      const [family, identity] = query.queryKey;
      if (typeof family !== 'string') return false;
      if (WORKSPACE_CONTENT.has(family)) {
        if ('workspaceId' in scope) return identity === scope.workspaceId;
        // Channel-only revocation filters this list in channelsRevoked, keeping unrelated rooms.
        if (family === families.channels[0]) return false;
        // Followed rows are cancelled, filtered and refreshed by channelsRevoked, preserving its undo contract.
        if (family === families.followedThreads[0] && query.state.data !== undefined) return false;
        return (
          unknownWorkspace || (typeof identity === 'string' && affectedWorkspaces.has(identity))
        );
      }
      if (CHANNEL_CONTENT.has(family))
        return affectedChannel(typeof identity === 'string' ? identity : undefined);
      if (MESSAGE_CONTENT.has(family))
        return affectedChannel(
          typeof identity === 'string' ? messageOwners.get(identity) : undefined,
        );
      if (family === keys.attachmentText('')[0])
        return affectedChannel(
          typeof identity === 'string' ? attachmentOwners.get(identity) : undefined,
        );
      return false;
    },
  });
  const selected = new Set(affected);
  invalidateAccess(affected);
  advanceAccessRevision(client);
  if (!refetch) {
    // A removed membership/module must not start another request under the old receipt.
    // Reset notifies active readers immediately; removal makes allowed consumers bind a fresh
    // Query after the new receipt is published, while the closed route unmounts its readers.
    for (const query of affected) query.reset();
    client.removeQueries({ predicate: (query) => selected.has(query) });
    return;
  }
  void client.resetQueries({ predicate: (query) => selected.has(query) });
};

/** A changed floor or membership discards affected and uncertain cached content before refetching. */
export const workspaceAccessChanged = (client: QueryClient, workspaceId: string): void => {
  resetContent(client, { workspaceId });
};

/** A channel-only loss keeps known other-channel history; unowned resource keys cannot be trusted. */
export const channelAccessRevoked = (client: QueryClient, channelIds: readonly string[]): void => {
  if (channelIds.length === 0) return;
  resetContent(client, { channelIds: new Set(channelIds) });
};

const sameAccess = (
  before: WorkspaceAccess | undefined,
  after: WorkspaceAccess | undefined,
): boolean => {
  const previous = before ?? { kind: 'member' as const };
  const current = after ?? { kind: 'member' as const };
  if (previous.kind !== current.kind) return false;
  if (previous.kind === 'member' || current.kind === 'member') return true;
  return previous.historySince === current.historySince && previous.expiresAt === current.expiresAt;
};

/** A reconnect or new admission may be the first current evidence after a missed control hint. */
export const accountAccessChanged = (
  client: QueryClient,
  before: MeResponse | undefined,
  after: MeResponse,
): void => {
  if (before === undefined) return;
  if (before.user.id !== after.user.id) {
    invalidateAccess(client.getQueryCache().findAll({ queryKey: keys.me, exact: true }));
    advanceAccessRevision(client);
    return;
  }
  const current = new Map(
    after.memberships.map((membership) => [membership.workspace.id, membership]),
  );
  for (const previous of before.memberships) {
    const next = current.get(previous.workspace.id);
    const hadChat = (previous.modules ?? before.modules).includes('chat');
    const hasChat = next !== undefined && (next.modules ?? after.modules).includes('chat');
    if (next === undefined || (hadChat && !hasChat))
      resetContent(client, { workspaceId: previous.workspace.id }, false);
    else if (!sameAccess(previous.access, next.access))
      workspaceAccessChanged(client, previous.workspace.id);
  }
};

/** Reconcile a fetched receipt after its Query commits, before queued readers see the new account. */
export const reconcileAccountOnCommit = (
  client: QueryClient,
  before: MeResponse | undefined,
  signal: AbortSignal,
): void => {
  if (signal.aborted) return;
  const cache = client.getQueryCache();
  const query = cache.get(client.defaultQueryOptions({ queryKey: keys.me }).queryHash);
  if (query === undefined) return;
  const stop = (): void => {
    unsubscribe();
    signal.removeEventListener('abort', stop);
  };
  const unsubscribe = cache.subscribe((event) => {
    if (event.query !== query) return;
    if (event.type === 'removed' || (event.type === 'updated' && event.action.type === 'error')) {
      stop();
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success' || event.action.manual === true)
      return;
    stop();
    const after = client.getQueryData<MeResponse>(keys.me);
    if (after === undefined) return;
    if (before !== undefined && before.user.id !== after.user.id)
      client.removeQueries({
        predicate: (entry) =>
          entry.queryKey.length !== keys.me.length || entry.queryKey[0] !== keys.me[0],
      });
    accountAccessChanged(client, before, after);
  });
  signal.addEventListener('abort', stop, { once: true });
};

/** Account-scoped signal: late refusals for another workspace never replace the current page. */
export const workspaceAccessRequiredKey = (workspaceId: string, userId: string) =>
  ['workspace-access-required', userId, workspaceId] as const;

export const workspaceAccessRequired = (client: QueryClient, workspaceId: string): void => {
  const me = client.getQueryData<MeResponse>(keys.me);
  if (!me?.memberships.some((member) => member.workspace.id === workspaceId)) return;
  const key = workspaceAccessRequiredKey(workspaceId, me.user.id);
  if (client.getQueryData<boolean>(key) === true) return;
  resetContent(client, { workspaceId }, false);
  client.setQueryData(key, true);
};
