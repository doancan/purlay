/**
 * What the cache does when the world changes.
 *
 * Two things change it: a socket frame (somebody else did something) and the answer
 * to this client's own request. Both land here, as one function each, so the cache
 * has exactly one way to learn a thing and a message that arrives twice — over the
 * socket and over a replay, or as an echo of one's own send — is the same row.
 *
 * Everything is a pure function of the `QueryClient`, which a test builds with no
 * React and no network. Nothing here invents a number: counters, thread summaries
 * and reaction sets are the server's, copied in (D-13, D-99), because a client that
 * counted for itself would drift from the column the first time two devices
 * disagreed.
 *
 * **Order is the id.** A UUIDv7 sorts by time, so every list is kept sorted by id
 * and an insert needs no timestamp and no tie-break (D-8).
 */
import type { InfiniteData, QueryClient, QueryKey } from '@tanstack/react-query';
import type {
  Channel,
  ChannelState,
  Message,
  MessagePage,
  Reaction,
  ThreadSummary,
  MessageRevision,
  NotificationLevel,
} from '@purlay/types';
import { families, keys } from './keys';

type Pages = InfiniteData<MessagePage, string | undefined>;

const byIdDescending = (a: Message, b: Message): number => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const byIdAscending = (a: Message, b: Message): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The message, replacing any row with its id, in its place by id. */
const placed = (
  list: readonly Message[],
  message: Message,
  order: (a: Message, b: Message) => number,
): Message[] => [...list.filter((m) => m.id !== message.id), message].sort(order);

const mapMessages = (pages: Pages, edit: (message: Message) => Message): Pages => ({
  ...pages,
  pages: pages.pages.map((page) => ({ ...page, data: page.data.map(edit) })),
});

const hasMessage = (pages: Pages, id: string): boolean =>
  pages.pages.some((page) => page.data.some((m) => m.id === id));

/** Every cached list that carries messages, as `[key, data]`. */
const messageLists = (client: QueryClient): [QueryKey, Pages][] => {
  const found: [QueryKey, Pages][] = [];
  for (const family of [families.messages, families.thread, families.unresolved]) {
    for (const [key, data] of client.getQueriesData<Pages>({ queryKey: family })) {
      if (data !== undefined) found.push([key, data]);
    }
  }
  return found;
};

/**
 * A list that is being fetched *now* was asked for before this change, and its answer may have been
 * written before it too: left alone, that answer replaces what the change just wrote, and the message,
 * the reaction or the edit is counted and announced and then missing from the screen until something
 * else reloads it. Found in a browser twice: a reply sent while its thread was still opening, and a
 * send while the subscription's answer was re-reading a feed already on the screen (#347). Asking
 * again, the in-flight request is cancelled — which keeps what is cached, change included — in favour
 * of one that starts after the change.
 */
const askAgainIfOnItsWay = (client: QueryClient, key: readonly unknown[]): void => {
  if (client.isFetching({ queryKey: key, exact: true }) === 0) return;
  // Invalidating alone would join the request already in flight when there is no data yet to
  // set aside; it has to be let go of first.
  void client
    .cancelQueries({ queryKey: key, exact: true })
    .then(() => client.invalidateQueries({ queryKey: key, exact: true, refetchType: 'all' }));
};

/**
 * Edits one message wherever it is cached — the feed, its thread, the open-questions
 * view — so a reaction or a resolution cannot be right in one place and stale in
 * another. A list that does not hold it is left alone.
 */
export const patchMessage = (
  client: QueryClient,
  messageId: string,
  edit: (message: Message) => Message,
): void => {
  for (const [key, data] of messageLists(client)) {
    if (!hasMessage(data, messageId)) continue;
    client.setQueryData<Pages>(
      key,
      mapMessages(data, (m) => (m.id === messageId ? edit(m) : m)),
    );
    askAgainIfOnItsWay(client, key);
  }
};

/**
 * A message arrived — live, replayed, or the echo of one's own send.
 *
 * A root goes into its channel's feed, a reply into its thread's list, each only if
 * that list is already cached (an uncached one loads whole, current, when opened).
 * Either way the channel moves to the top of the sidebar's order.
 */
export const messageCreated = (client: QueryClient, message: Message): void => {
  if (message.parentId === null) {
    const key = keys.messages(message.channelId);
    const cached = client.getQueryData<Pages>(key);
    if (cached !== undefined) {
      const [first, ...rest] = cached.pages;
      if (first !== undefined) {
        client.setQueryData<Pages>(key, {
          ...cached,
          pages: [{ ...first, data: placed(first.data, message, byIdDescending) }, ...rest],
        });
      }
    }
    askAgainIfOnItsWay(client, key);
  } else {
    const key = keys.thread(message.parentId);
    const cached = client.getQueryData<Pages>(key);
    const last = cached?.pages.at(-1);
    if (cached !== undefined && last !== undefined) {
      client.setQueryData<Pages>(key, {
        ...cached,
        pages: [
          ...cached.pages.slice(0, -1),
          { ...last, data: placed(last.data, message, byIdAscending) },
        ],
      });
    }
    askAgainIfOnItsWay(client, key);
  }
  touchChannel(client, message.channelId, message.createdAt);
};

const editChannels = (
  client: QueryClient,
  channelId: string,
  edit: (channel: Channel) => Channel,
): void => {
  for (const [key, list] of client.getQueriesData<Channel[]>({ queryKey: families.channels })) {
    if (list?.some((c) => c.id === channelId) !== true) continue;
    client.setQueryData<Channel[]>(
      key,
      list.map((c) => (c.id === channelId ? edit(c) : c)),
    );
  }
};

/** Moves the channel's latest activity forward; never back (a late replay must not undo it). */
const touchChannel = (client: QueryClient, channelId: string, at: string): void => {
  editChannels(client, channelId, (c) =>
    c.lastMessageAt !== null && c.lastMessageAt >= at ? c : { ...c, lastMessageAt: at },
  );
};

/** A root's replies changed: the summary on the root, and the open-questions view re-asks. */
export const threadUpdated = (
  client: QueryClient,
  messageId: string,
  thread: ThreadSummary,
): void => {
  patchMessage(client, messageId, (m) => ({ ...m, thread }));
  // Whether a thread is open or resolved decides if it belongs in that view at all,
  // and which page it falls on; asking again is cheaper than reasoning about it.
  void client.invalidateQueries({ queryKey: families.unresolved });
};

/** A message's whole reaction set, replacing what was there. */
export const reactionsUpdated = (
  client: QueryClient,
  messageId: string,
  reactions: readonly Reaction[],
): void => {
  patchMessage(client, messageId, (m) => ({ ...m, reactions: [...reactions] }));
};

/**
 * A message was edited or deleted (D-103): its words, its times and who it names, replaced.
 * A deleted root nobody answered leaves every list, as it leaves the feed the server reads; one
 * with replies stays as its tombstone, with its thread. The open questions are asked again: the
 * server lists no deleted root there.
 */
export const messageRevised = (client: QueryClient, revision: MessageRevision): void => {
  const id = revision.messageId;
  const deletedRoot = revision.deletedAt !== null && revision.parentId === null;
  for (const [key, data] of messageLists(client)) {
    const held = data.pages.flatMap((page) => page.data).find((m) => m.id === id);
    if (held === undefined) continue;
    const leaves = deletedRoot && (held.thread?.replyCount ?? 0) === 0;
    client.setQueryData<Pages>(
      key,
      leaves
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              data: page.data.filter((m) => m.id !== id),
            })),
          }
        : mapMessages(data, (m) =>
            m.id === id
              ? {
                  ...m,
                  content: revision.content,
                  editedAt: revision.editedAt,
                  deletedAt: revision.deletedAt,
                  mentions: [...revision.mentions],
                }
              : m,
          ),
    );
    askAgainIfOnItsWay(client, key);
  }
  if (deletedRoot) void client.invalidateQueries({ queryKey: families.unresolved });
};

/** The caller's own position and counters in one channel — the server's numbers, copied. */
export const channelStateChanged = (
  client: QueryClient,
  channelId: string,
  state: ChannelState,
): void => {
  const before = client
    .getQueriesData<Channel[]>({ queryKey: families.channels })
    .flatMap(([, list]) => list ?? [])
    .find((c) => c.id === channelId);
  editChannels(client, channelId, (c) => ({ ...c, state }));
  // More waiting for you is a new notification: the inbox, if it is open, asks again (D-106).
  if (before !== undefined && state.unreadMentionCount > (before.state?.unreadMentionCount ?? 0)) {
    void client.invalidateQueries({ queryKey: keys.notifications(before.workspaceId) });
  }
};

/** The caller's notification level in a channel, as they chose it or as it was before a refusal. */
export const channelLevelChanged = (
  client: QueryClient,
  channelId: string,
  notificationLevel: NotificationLevel,
): void => {
  editChannels(client, channelId, (c) => ({ ...c, notificationLevel }));
};

/** A channel's name or topic changed (D-123): what every screen showing it reads from. */
export const channelRenamed = (
  client: QueryClient,
  channelId: string,
  named: { readonly name: string; readonly topic: string | null },
): void => {
  editChannels(client, channelId, (c) => ({ ...c, name: named.name, topic: named.topic }));
};

/** A channel appeared for the caller. Added once, however many frames say so. */
export const channelAdded = (client: QueryClient, channel: Channel): void => {
  const key = keys.channels(channel.workspaceId);
  const list = client.getQueryData<Channel[]>(key);
  if (list === undefined) {
    void client.invalidateQueries({ queryKey: key });
    return;
  }
  client.setQueryData<Channel[]>(key, [...list.filter((c) => c.id !== channel.id), channel]);
};

/** Delivery for these channels stopped. They leave the list and their messages leave the cache. */
export const channelsRevoked = (client: QueryClient, channelIds: readonly string[]): void => {
  for (const [key, list] of client.getQueriesData<Channel[]>({ queryKey: families.channels })) {
    if (list === undefined) continue;
    client.setQueryData<Channel[]>(
      key,
      list.filter((c) => !channelIds.includes(c.id)),
    );
  }
  for (const id of channelIds) {
    client.removeQueries({ queryKey: keys.messages(id) });
    client.removeQueries({ queryKey: keys.channelMembers(id) });
  }
  // A thread is keyed by its root, not its channel: one whose messages are the channel's goes too.
  client.removeQueries({
    queryKey: families.thread,
    predicate: (query) =>
      ((query.state.data as Pages | undefined)?.pages ?? []).some((page) =>
        page.data.some((m) => channelIds.includes(m.channelId)),
      ),
  });
};

/** The newest message id the cache holds for a channel's feed — what a read position names. */
export const newestMessageId = (client: QueryClient, channelId: string): string | null =>
  client.getQueryData<Pages>(keys.messages(channelId))?.pages[0]?.data[0]?.id ?? null;
