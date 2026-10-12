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
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  Channel,
  MeResponse,
  Message,
  MessagePage,
  NotificationPage,
  WorkspaceMember,
} from '@purlay/types';
import { SEARCH_QUERY_MIN } from '@purlay/types';
import { useApi } from './api-provider';
import { keys } from './keys';

type Pages = InfiniteData<MessagePage, string | undefined>;

export const useMe = (): UseQueryResult<MeResponse> => {
  const api = useApi();
  return useQuery({ queryKey: keys.me, queryFn: ({ signal }) => api.me(signal) });
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

/** The feed: root messages, the newest page first and older ones as asked for. */
export const useMessages = (channelId: string): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.messages(channelId),
    queryFn: ({ pageParam, signal }) => api.messages(channelId, { before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...KEEP_MESSAGES,
  });
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

/** The open-questions view: unresolved roots with replies, newest first. */
export const useUnresolved = (workspaceId: string): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.unresolved(workspaceId),
    queryFn: ({ pageParam, signal }) => api.unresolved(workspaceId, { before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    ...KEEP_MESSAGES,
  });
};

/** The caller's inbox in one workspace, newest first, a page at a time (D-106). */
export const useNotifications = (
  workspaceId: string,
): UseInfiniteQueryResult<InfiniteData<NotificationPage>> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.notifications(workspaceId),
    queryFn: ({ pageParam, signal }) =>
      api.notifications(workspaceId, { before: pageParam }, signal),
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
): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.search(workspaceId, words, channelId),
    queryFn: ({ pageParam, signal }) =>
      api.search(
        workspaceId,
        { q: words, before: pageParam, ...(channelId === null ? {} : { channelId }) },
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
export const readingOrder = (data: Pages | undefined): Message[] =>
  data === undefined ? [] : [...data.pages].reverse().flatMap((page) => [...page.data].reverse());

/** A thread's replies, which are already oldest first. */
export const repliesOf = (data: Pages | undefined): Message[] =>
  data === undefined ? [] : data.pages.flatMap((page) => page.data);
