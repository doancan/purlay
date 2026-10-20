/**
 * How many questions are open: the number on the "Open questions" tab and in the sidebar.
 *
 * It is the open-questions view's own first page, counted — one request and one cache
 * entry shared with the view itself (`keys.unresolved`), so the number and the list can
 * never disagree and nothing is asked twice. The server keeps the list current: a thread
 * resolved anywhere changes it through `THREAD_UPDATED` (`data/cache.ts`).
 *
 * A page holds `PAGE_LIMIT.default` (`@purlay/types`); when there is more the count is a floor
 * and says so (`more`), which the header shows with a "+" — an honest number rather than a
 * request for every page to produce one nobody needs.
 */
import { useUnresolved } from '../../data/queries';

export interface OpenCount {
  readonly count: number;
  /** There are more pages than the one counted: `count` is a floor. */
  readonly more: boolean;
}

/**
 * `null` while the first page has not arrived (and when it failed): show nothing, not zero.
 * With a channel, that channel's own questions are counted, asked of the server by channel: a
 * channel's header says its own number, the rail and the sidebar the workspace's (`UX.md` §2).
 * Counted from the workspace's pages it was a floor of the floor — a quiet channel's questions past
 * the workspace's first page went uncounted.
 */
export const useOpenCount = (
  workspaceId: string,
  channelId: string | null = null,
): OpenCount | null => {
  const { data } = useUnresolved(workspaceId, channelId);
  if (data === undefined) return null;
  const last = data.pages.at(-1);
  const count = data.pages.reduce((sum, page) => sum + page.data.length, 0);
  return { count, more: last !== undefined && last.nextCursor !== null };
};
