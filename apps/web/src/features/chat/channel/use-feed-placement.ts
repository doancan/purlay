/**
 * Where a channel opens (`UX.md` §6): whether the reader's place is in hand yet, and the
 * unread marker that follows from it.
 *
 * **A channel opens where the reader's place is, so the place has to be in hand first.** The
 * read position may be older than everything the first page holds (ninety unread in a page of
 * fifty); the marker would then sit above the oldest *loaded* message, the reader would be
 * placed there, and the pages that arrive above would carry them nowhere near the real line
 * (found in a browser, in a channel with two hundred messages and the position at the 120th).
 * Until the position is inside what is loaded — or the reader has been placed once, or the
 * search has gone `SEEK_LIMIT_PAGES` back — older pages are read and the feed is not shown.
 */
import { useEffect, useRef } from 'react';
import type { UseInfiniteQueryResult } from '@tanstack/react-query';
import type { Message } from '@purlay/types';
import type { FeedPages } from '../../../data/queries';

/**
 * How many pages back the feed will read to find the reader's place before opening where it
 * is. Ten pages is five hundred messages: a place older than that is not a place the reader is
 * coming back to, and the cost of finding it is a wait they would notice.
 */
export const SEEK_LIMIT_PAGES = 10;

interface Placement {
  /** Older pages are being read to find the reader's place; the feed is not shown yet. */
  readonly seeking: boolean;
  /** The unread marker to draw: `undefined` for none (yet). */
  readonly marker: string | null | undefined;
}

export const useFeedPlacement = (
  feed: UseInfiniteQueryResult<FeedPages>,
  messages: readonly Message[],
  markerAfter: string | null | undefined,
  windowed: boolean,
): Placement => {
  const placed = useRef(false);
  // A link is followed to its message, not to the reader's unread place.
  const markerFor = windowed ? undefined : markerAfter;
  const behind =
    typeof markerFor === 'string' &&
    messages.length > 0 &&
    !messages.some((m) => m.id <= markerFor);
  const seeking =
    !placed.current &&
    behind &&
    feed.hasNextPage &&
    (feed.data?.pages.length ?? 0) < SEEK_LIMIT_PAGES;
  useEffect(() => {
    if (feed.isSuccess && !seeking) placed.current = true;
  }, [feed.isSuccess, seeking]);
  // "Never read anything" means the marker is above the oldest message — which is only
  // the oldest *loaded* one until the first page reaches the beginning.
  const marker = seeking || (markerFor === null && feed.hasNextPage) ? undefined : markerFor;
  return { seeking, marker };
};
