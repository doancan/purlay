/**
 * What a screen reads, as hooks. Each is a query over one `Api` call, keyed by
 * `keys`, so the socket's frames (`cache.ts`) and the screens address the same
 * entries.
 *
 * The three lists that grow are infinite queries because they are keyset pages
 * (`API.md` §1): the feed and the open questions page **backwards** from the newest
 * (`before`), a thread forwards (`after`), and each page's `nextCursor` is the one
 * value that continues it — null is the end. Nothing is ever fetched by offset.
 */
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AuthMethods,
  MySignIn,
  Channel,
  MeResponse,
  Message,
  MessagePage,
  FilePage,
  NotificationPage,
  WorkspaceMember,
  ChannelMember,
  ThreadFollow,
} from '@purlay/types';
import { SEARCH_QUERY_MIN } from '@purlay/types';
import { useApi } from './api-provider';
import type { SetupStatusAnswer } from './api';
import { isTransient } from './errors';
import { claimFor } from './browser-storage';
import { useClientStorage } from './storage-provider';
import { keys } from './keys';

type Pages = InfiniteData<MessagePage, string | undefined>;

export const useMe = (): UseQueryResult<MeResponse> => {
  const api = useApi();
  const storage = useClientStorage();
  const client = useQueryClient();
  return useQuery({
    queryKey: keys.me,
    queryFn: async ({ signal }) => {
      const me = await api.me(signal);
      // The cookie is the browser's, so a page that held one person can read back another — they
      // signed in in another tab. Nothing this page cached was theirs (#694).
      const before = client.getQueryData<MeResponse>(keys.me);
      if (before !== undefined && before.user.id !== me.user.id) {
        client.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
      }
      // Before the answer reaches a screen, so no composer reads somebody else's draft (#694).
      claimFor(storage, me.user.id);
      return me;
    },
  });
};

/** How many more times, and how long before the first, the methods are asked for (`useAuthMethods`). */
const AUTH_METHODS_RETRIES = 3;
const AUTH_METHODS_RETRY_MS = 400;

/** Which ways in this server offers (D-138 §6): the sign-in screen shows only what works. */
export const useAuthMethods = (enabled = true): UseQueryResult<AuthMethods> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.authMethods,
    queryFn: ({ signal }) => api.authMethods(signal),
    enabled,
    // The one question the sign-in screen cannot do without, so a hiccup is retried before it is
    // shown: up to three more asks, 0.4 s, 0.8 s and 1.6 s apart (the client's default is one retry
    // after TanStack's 1 s), and only for a failure a retry may mend.
    retry: (failures, error) => failures < AUTH_METHODS_RETRIES && isTransient(error),
    retryDelay: (failures) => AUTH_METHODS_RETRY_MS * 2 ** failures,
  });
};

/**
 * Whether the server is open to setup, asked once (`/` on a fresh server goes to the wizard). Never
 * retried, never refetched: the status shares the sign-in rate-limit bucket, and an answer that is not
 * `open` — a 429 included — is the ordinary one (`SessionGate`, the wizard's entry).
 */
export const useSetupStatus = (enabled = true): UseQueryResult<SetupStatusAnswer> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.setupStatus,
    queryFn: ({ signal }) => api.setupStatus(signal),
    enabled,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
};

/** The ways the caller signs in, and the GitHub account linked to it, if any (D-176, D-179 §5). */
export const useMySignIn = (): UseQueryResult<MySignIn> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.mySignIn,
    queryFn: ({ signal }) => api.mySignIn(signal),
  });
};

export const useChannels = (workspaceId: string): UseQueryResult<Channel[]> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.channels(workspaceId),
    queryFn: ({ signal }) => api.channels(workspaceId, signal),
  });
};

export const useMembers = (workspaceId: string): UseQueryResult<WorkspaceMember[]> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.members(workspaceId),
    queryFn: ({ signal }) => api.members(workspaceId, signal),
  });
};

/**
 * Who is in a channel (D-123): read when the channel's details open, again after a change, and by
 * the composer of a private channel, whose `@` list offers only them. `enabled` false reads nothing.
 */
export const useChannelMembers = (
  channelId: string,
  enabled = true,
): UseQueryResult<ChannelMember[]> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.channelMembers(channelId),
    queryFn: ({ signal }) => api.channelMembers(channelId, signal),
    enabled,
  });
};

/**
 * Pages of messages keep the identity of every message they hold.
 *
 * TanStack's structural sharing compares a new list to the old one *by position* and builds
 * a fresh object for any element that differs there — so a message inserted at the head of
 * a feed shifts every later message to a new index and every one of them is copied. A row is
 * memoised on its message's identity (`features/messages/message-row.tsx`), so a copy is a
 * re-render: one new message would redraw the whole page. The cache (`cache.ts`) already
 * keeps untouched messages as they were; this stops the library undoing it.
 */
const KEEP_MESSAGES = { structuralSharing: false } as const;

/**
 * A page of a feed. A window around a message (D-149) reads both ways: `nextCursor` continues it
 * older, as on every page, and `newerCursor` — read on the newest page only — newer. Absent or null,
 * the page reaches the present, and a message arriving belongs on it (`cache.ts`). `target` is on
 * the page that opened the window: the message the link names.
 */
type FeedPage = MessagePage & {
  readonly newerCursor?: string | null;
  readonly target?: Message;
};
export type FeedPages = InfiniteData<FeedPage>;

/** Where a window's page starts: around the message linked, older than an id, or newer than one. */
type WindowParam =
  { readonly around: string } | { readonly before: string } | { readonly after: string };

/**
 * The feed: root messages, the newest page first and older ones as asked for — or, given a message
 * a link names (`around`), the window around it, read older and newer from there (D-149). Both are
 * pages under the channel's key, so whatever edits the one edits the other.
 */
export const useMessages = (
  channelId: string,
  around: string | null = null,
): UseInfiniteQueryResult<FeedPages> => {
  const api = useApi();
  const present = useInfiniteQuery({
    queryKey: keys.messages(channelId),
    queryFn: ({ pageParam, signal }) => api.messages(channelId, { before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: around === null,
    ...KEEP_MESSAGES,
  });
  const window = useInfiniteQuery({
    queryKey: keys.messagesAround(channelId, around),
    queryFn: async ({ pageParam, signal }): Promise<FeedPage> => {
      if ('around' in pageParam) {
        const found = await api.messageWindow(pageParam.around, signal);
        return {
          data: found.data,
          nextCursor: found.olderCursor,
          newerCursor: found.newerCursor,
          target: found.target,
        };
      }
      if ('after' in pageParam) {
        const newer = await api.messages(channelId, { after: pageParam.after }, signal);
        const data = [...newer.data].reverse();
        // A list read again is read forwards from its first page, which may be this one: older
        // than it goes on from its oldest message.
        return {
          data,
          nextCursor: data.at(-1)?.id ?? pageParam.after,
          newerCursor: newer.nextCursor,
        };
      }
      return await api.messages(channelId, { before: pageParam.before }, signal);
    },
    initialPageParam: { around: around ?? '' },
    getNextPageParam: (last: FeedPage): WindowParam | undefined =>
      last.nextCursor === null ? undefined : { before: last.nextCursor },
    getPreviousPageParam: (first: FeedPage): WindowParam | undefined =>
      first.newerCursor === undefined || first.newerCursor === null
        ? undefined
        : { after: first.newerCursor },
    enabled: around !== null,
    ...KEEP_MESSAGES,
  });
  return around === null ? present : window;
};

/** One thread's replies, oldest first, a page at a time. */
export const useThread = (messageId: string, enabled = true): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.thread(messageId),
    queryFn: ({ pageParam, signal }) => api.thread(messageId, { after: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled,
    ...KEEP_MESSAGES,
  });
};

/** Whether the caller is told of new replies in a root's thread (D-161). */
export const useThreadFollow = (rootId: string, enabled = true): UseQueryResult<ThreadFollow> => {
  const api = useApi();
  return useQuery({
    queryKey: keys.threadFollow(rootId),
    queryFn: ({ signal }) => api.threadFollow(rootId, signal),
    enabled,
  });
};

/** A channel's files, newest message first, a page at a time (D-129). */
export const useChannelFiles = (
  channelId: string,
): UseInfiniteQueryResult<InfiniteData<FilePage>> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.files(channelId),
    queryFn: ({ pageParam, signal }) => api.files(channelId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

/**
 * The open-questions view: unresolved roots with replies, newest first — the workspace's, or with a
 * channel that channel's alone, asked of the server so its count and list need no workspace page.
 */
export const useUnresolved = (
  workspaceId: string,
  channelId: string | null = null,
): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.unresolved(workspaceId, channelId),
    queryFn: ({ pageParam, signal }) =>
      api.unresolved(
        workspaceId,
        { before: pageParam, ...(channelId === null ? {} : { channelId }) },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...KEEP_MESSAGES,
  });
};

/** The caller's inbox in one workspace, newest first, a page at a time (D-106). */
export const useNotifications = (
  workspaceId: string,
  unreadOnly = false,
): UseInfiniteQueryResult<InfiniteData<NotificationPage>> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: unreadOnly
      ? keys.notifications(workspaceId, 'unread')
      : keys.notifications(workspaceId),
    queryFn: ({ pageParam, signal }) =>
      api.notifications(
        workspaceId,
        unreadOnly ? { before: pageParam, unreadOnly } : { before: pageParam },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

/**
 * One search, newest first, a page at a time (D-105). Asked only for words the server would take:
 * below the minimum the screen says so instead.
 */
export const useSearch = (
  workspaceId: string,
  words: string,
  channelId: string | null = null,
  authorId: string | null = null,
): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.search(workspaceId, words, channelId, authorId),
    queryFn: ({ pageParam, signal }) =>
      api.search(
        workspaceId,
        {
          q: words,
          before: pageParam,
          ...(channelId === null ? {} : { channelId }),
          ...(authorId === null ? {} : { senderId: authorId }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: words.length >= SEARCH_QUERY_MIN,
  });
};

/**
 * A feed in reading order, oldest first. The pages arrive newest first, each page
 * newest first, so reading order is the whole reversed — never a sort, because the
 * cache already keeps ids in order and a sort would hide a cache that did not.
 */
export const readingOrder = (data: InfiniteData<MessagePage> | undefined): Message[] =>
  data === undefined ? [] : [...data.pages].reverse().flatMap((page) => [...page.data].reverse());

/** A thread's replies, which are already oldest first. */
export const repliesOf = (data: Pages | undefined): Message[] =>
  data === undefined ? [] : data.pages.flatMap((page) => page.data);
