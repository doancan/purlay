/**
 * How many questions are open: the number on the "Open questions" tab and in the sidebar.
 *
 * It is the open-questions view's own first page, counted — one request and one cache
 * entry shared with the view itself (`keys.unresolved`), so the number and the list can
 * never disagree and nothing is asked twice. The server keeps the list current: a thread
 * resolved anywhere changes it through `THREAD_UPDATED` (`data/cache.ts`).
 *
 * A page holds at most a hundred; when there is more the count is a floor and says so
 * (`more`), which the interface shows as "100+" — an honest number rather than a request
 * for every page to produce one nobody needs.
 */
import { useUnresolved } from '../../data/queries';

export interface OpenCount {
  readonly count: number;
  /** There are more pages than the one counted: `count` is a floor. */
  readonly more: boolean;
}

/**
 * `null` while the first page has not arrived (and when it failed): show nothing, not zero.
 * With a channel, only that channel's questions are counted, from the same pages: a channel's
 * header says its own number, the rail and the sidebar the workspace's (`UX.md` §2).
 */
export const useOpenCount = (
  workspaceId: string,
  channelId: string | null = null,
): OpenCount | null => {
  const { data } = useUnresolved(workspaceId);
  if (data === undefined) return null;
  const last = data.pages.at(-1);
  const count = data.pages.reduce(
    (sum, page) =>
      sum +
      (channelId === null
        ? page.data.length
        : page.data.filter((question) => question.channelId === channelId).length),
    0,
  );
  return { count, more: last !== undefined && last.nextCursor !== null };
};
