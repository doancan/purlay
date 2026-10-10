/**
 * When a channel counts as read (`UX.md` §6, D-98 §5, D-99 §4).
 *
 * **Marking read is something the person did, not something that rendered.** It happens
 * when they are at the bottom of the channel *and* the page is in front of them *and* there
 * is a message past what they had already read — and then only after a pause, so scrolling
 * through the bottom is one request and not twenty. It also happens once more when they
 * leave, for the newest message they had reached. A channel opened scrolled to an unread
 * marker (not at the bottom) is not read until they get there; a hidden tab is not reading.
 *
 * The position only moves forward: an id at or behind what was already sent is never sent
 * again, and the server agrees (a position behind the current one is a no-op there too).
 * A failed request is not retried in a loop — the next arrival at the bottom tries again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import type { FeedPorts } from './feed-ports';

/** How long the bottom must hold before the position is sent. */
export const READ_DEBOUNCE_MS = 500;

interface Options {
  readonly channelId: string;
  /** Only members have a read position; a channel merely visible has none to move. */
  readonly member: boolean;
  /** The position when the channel was opened. */
  readonly readAtOpen: string | null;
  /** The newest message the server has confirmed in the feed. */
  readonly newestId: string | null;
  readonly atBottom: boolean;
  readonly ports: FeedPorts;
}

export const useMarkRead = ({
  channelId,
  member,
  readAtOpen,
  newestId,
  atBottom,
  ports,
}: Options): void => {
  const { markRead } = useActions();
  const sent = useRef(readAtOpen);
  const reached = useRef<string | null>(null);
  const [visible, setVisible] = useState(() => ports.pageVisible());

  useEffect(
    () =>
      ports.onPageVisibility(() => {
        setVisible(ports.pageVisible());
      }),
    [ports],
  );

  const send = useCallback(
    (id: string): void => {
      if (sent.current !== null && id <= sent.current) return;
      const previous = sent.current;
      sent.current = id;
      markRead(channelId, id).catch(() => {
        // Let the next arrival at the bottom try again, unless something newer went out since.
        if (sent.current === id) sent.current = previous;
      });
    },
    [channelId, markRead],
  );

  useEffect(() => {
    if (!member || !atBottom || !visible || newestId === null) return undefined;
    reached.current = newestId;
    if (sent.current !== null && newestId <= sent.current) return undefined;
    return ports.schedule(() => {
      send(newestId);
    }, READ_DEBOUNCE_MS);
  }, [member, atBottom, visible, newestId, ports, send]);

  // Leaving the channel — or the page — reads what the person had reached.
  const leave = useRef(send);
  leave.current = send;
  useEffect(
    () => (): void => {
      if (member && reached.current !== null) leave.current(reached.current);
    },
    [member, channelId],
  );
};
