/**
 * What makes the feed read another page: the top and bottom sentinels coming into view, the
 * search for the reader's place, and a thread the address asks for. One page at a time, and
 * none by itself after a failure — only the retry buttons ask then.
 */
import { useCallback, useEffect } from 'react';
import type { UseInfiniteQueryResult } from '@tanstack/react-query';
import type { FeedPages } from '../../../data/queries';
import type { FeedPorts } from './feed-ports';

interface FeedPagingInput {
  readonly feed: UseInfiniteQueryResult<FeedPages>;
  readonly scroller: React.RefObject<HTMLDivElement | null>;
  readonly top: React.RefObject<HTMLDivElement | null>;
  readonly bottom: React.RefObject<HTMLDivElement | null>;
  readonly ready: boolean;
  readonly seeking: boolean;
  /** The thread the address asks for is older than anything loaded. */
  readonly wanted: boolean;
  /** Called before a newer page is read: the reader stays where they are. */
  readonly extendBelow: () => void;
  readonly ports: FeedPorts;
}

/** Wires the page reads, and returns the one the bottom row's retry button calls. */
export const useFeedPaging = ({
  feed,
  scroller,
  top,
  bottom,
  ready,
  seeking,
  wanted,
  extendBelow,
  ports,
}: FeedPagingInput): (() => void) => {
  // Older pages load when the top comes into view, one at a time.
  //
  // **A page that failed is not asked for again by itself.** The observer reports "visible"
  // whenever it is set up and the top row is on screen, and a failed fetch ends the fetching
  // state, which sets it up anew: without the error check one outage was a loop of requests
  // with no back-off, hammering the server while the row said "Try again". Only that button
  // asks after a failure.
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = feed;
  useEffect(() => {
    const root = scroller.current;
    const target = top.current;
    if (!ready || root === null || target === null || !hasNextPage || isFetchNextPageError) {
      return undefined;
    }
    return ports.whenVisible(target, root, () => {
      if (!isFetchingNextPage) void fetchNextPage();
    });
  }, [ready, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, ports]);

  // Reading back to the reader's place (see `useFeedPlacement`), one page at a time.
  // The count of pages is a dependency because a page that arrives before the render that would
  // have shown `isFetchingNextPage` leaves every other dependency as it was.
  const pagesLoaded = feed.data?.pages.length ?? 0;
  useEffect(() => {
    if (seeking && !isFetchingNextPage) void fetchNextPage();
  }, [seeking, isFetchingNextPage, fetchNextPage, pagesLoaded]);

  // A thread the address asks for may be older than the first page: read back until its root
  // is here or there is nothing older, one page at a time.
  useEffect(() => {
    if (wanted && ready && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [wanted, ready, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  // Newer pages of a window load when its bottom comes into view, one at a time, and — like older
  // ones — are not asked for again by themselves after a failure. They are history read in below,
  // not news: the reader stays where they are (`extendBelow`).
  const { hasPreviousPage, isFetchingPreviousPage, isFetchPreviousPageError, fetchPreviousPage } =
    feed;
  const readNewer = useCallback((): void => {
    extendBelow();
    void fetchPreviousPage();
  }, [extendBelow, fetchPreviousPage]);
  useEffect(() => {
    const root = scroller.current;
    const edge = bottom.current;
    if (!ready || root === null || edge === null || !hasPreviousPage || isFetchPreviousPageError) {
      return undefined;
    }
    return ports.whenVisible(edge, root, () => {
      if (!isFetchingPreviousPage) readNewer();
    });
  }, [ready, hasPreviousPage, isFetchingPreviousPage, isFetchPreviousPageError, readNewer, ports]);
  return readNewer;
};
