/**
 * Bringing a linked message into view (D-149): the message a link names, or the root of the
 * thread the address opened. Says when a link names nothing readable, scrolls the row into
 * view once it is drawn, and marks the message for a moment.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { UseInfiniteQueryResult } from '@tanstack/react-query';
import { ApiError } from '../../../data/errors';
import type { FeedPages } from '../../../data/queries';
import { LANDED_MS } from '../messages/message-link';
import { useThreads } from '../threads/thread-context';
import type { FeedPorts } from './feed-ports';

interface FeedRevealInput {
  readonly feed: UseInfiniteQueryResult<FeedPages>;
  readonly channelId: string;
  readonly scroller: React.RefObject<HTMLDivElement | null>;
  /** The feed is drawn and the reader is placed. */
  readonly ready: boolean;
  readonly openThread: string | null;
  readonly around: string | null;
  /** Lets go of the bottom so the reveal is not carried away from. */
  readonly holdPlace: () => void;
  readonly onLinkMissing: ((messageId: string) => void) | undefined;
  readonly ports: FeedPorts;
}

/** Returns the message to mark as landed on, for a moment, or `null`. */
export const useFeedReveal = ({
  feed,
  channelId,
  scroller,
  ready,
  openThread,
  around,
  holdPlace,
  onLinkMissing,
  ports,
}: FeedRevealInput): string | null => {
  const threads = useThreads();
  const windowed = around !== null;
  // The message the link names, from the page that opened the window.
  const target = useMemo(
    () => feed.data?.pages.find((page) => page.target !== undefined)?.target,
    [feed.data],
  );

  // A link that names nothing the person can read here — gone, never theirs, another channel's — is
  // said by the screen, which opens the channel as it is (D-149).
  const missing =
    windowed &&
    ((feed.isError &&
      feed.data === undefined &&
      feed.error instanceof ApiError &&
      feed.error.code === 'MESSAGE_NOT_FOUND') ||
      (target !== undefined && target.channelId !== channelId));
  useEffect(() => {
    if (missing) onLinkMissing?.(around);
  }, [missing, around, onLinkMissing]);

  // The row to bring into view: the root of the thread the address opened, or the one a link names
  // (a reply's root, whose thread then opens). The reader was put at the bottom when the feed
  // opened, and the feed follows the bottom while the box around it changes size: without letting
  // go first, the older pages read back above it carry the reader straight back down, out of sight
  // of the thing the link was for (found in a browser, in a channel with a hundred messages).
  const revealId = windowed
    ? target === undefined || missing
      ? null
      : (target.parentId ?? target.id)
    : openThread;
  const revealed = useRef(revealId === null && !windowed);
  const [landed, setLanded] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (revealed.current || !ready || revealId === null) return;
    const row = scroller.current?.querySelector<HTMLElement>(
      `[data-message-row][data-message-id="${revealId}"]`,
    );
    if (row === null || row === undefined) return;
    revealed.current = true;
    holdPlace();
    row.scrollIntoView({ block: 'center' });
    if (target === undefined) return;
    // A reply is marked in its thread, which takes focus there; a root is marked here, and focused.
    if (target.parentId !== null) {
      threads.open(target.parentId, 'none');
      return;
    }
    row.focus({ preventScroll: true });
    setLanded(target.id);
  });
  useEffect(() => {
    if (landed === null) return undefined;
    return ports.schedule(() => {
      setLanded(null);
    }, LANDED_MS);
  }, [landed, ports]);
  return landed;
};
