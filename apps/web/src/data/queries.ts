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
import type { Channel, MeResponse, Message, MessagePage, WorkspaceMember } from '@purlay/types';
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

/** The feed: root messages, the newest page first and older ones as asked for. */
export const useMessages = (channelId: string): UseInfiniteQueryResult<Pages> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: keys.messages(channelId),
    queryFn: ({ pageParam, signal }) => api.messages(channelId, { before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
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
