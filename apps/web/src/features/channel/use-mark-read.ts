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
 * A failed request is tried once more after a longer pause — a blip on the way is the usual
 * cause, and a position that never reaches the server is a channel that shows unread again
 * on the next load. Not in a loop: if that fails too, or the person has already left, the
 * newest id is **owed** and sent the next time the channel is opened, so what they read is
 * not forgotten for want of a second request.
 *
 * **Held after "mark unread"** (D-212). A channel marked unread from a message is not read again by
 * being looked at: the person asked for it to wait. Nothing is sent — not at the bottom, not on
 * leaving — for the rest of the visit; the next time the channel is opened it reads as it always did.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import type { Actions } from '../../data/actions';
import type { FeedPorts } from './feed-ports';

/** How long the bottom must hold before the position is sent. */
export const READ_DEBOUNCE_MS = 500;

/** How long a failed request waits before its one retry. */
export const READ_RETRY_MS = 2_000;

/** Positions the server did not take, per page (per `Actions`), by channel. */
const owedBy = new WeakMap<Actions, Map<string, string>>();
const owedOf = (actions: Actions): Map<string, string> => {
  let owed = owedBy.get(actions);
  if (owed === undefined) {
    owed = new Map();
    owedBy.set(actions, owed);
  }
  return owed;
};

/** Channels marked unread during this visit, per page (per `Actions`): not read until left. */
const heldBy = new WeakMap<Actions, Set<string>>();
const heldOf = (actions: Actions): Set<string> => {
  let held = heldBy.get(actions);
  if (held === undefined) {
    held = new Set();
    heldBy.set(actions, held);
  }
  return held;
};

/** Stops the open channel from being read by being looked at, until it is left (D-212). */
export const holdUnread = (actions: Actions, channelId: string): void => {
  heldOf(actions).add(channelId);
};

/** Lets it be read again: the mark did not reach the server, so there is nothing to keep. */
export const releaseUnread = (actions: Actions, channelId: string): void => {
  heldOf(actions).delete(channelId);
};

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
  const actions = useActions();
  const { markRead } = actions;
  const alive = useRef(true);
  const retry = useRef<(() => void) | null>(null);
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
    (id: string, again = true): void => {
      if (heldOf(actions).has(channelId)) return;
      if (sent.current !== null && id <= sent.current) return;
      const previous = sent.current;
      sent.current = id;
      markRead(channelId, id).then(
        () => {
          const owed = owedOf(actions);
          const waiting = owed.get(channelId);
          if (waiting !== undefined && waiting <= id) owed.delete(channelId);
        },
        () => {
          // Unless something newer went out since, the position is still the old one.
          if (sent.current === id) sent.current = previous;
          const owed = owedOf(actions);
          const waiting = owed.get(channelId);
          if (waiting === undefined || waiting < id) owed.set(channelId, id);
          if (again && alive.current) {
            retry.current?.();
            retry.current = ports.schedule(() => {
              retry.current = null;
              send(id, false);
            }, READ_RETRY_MS);
          }
        },
      );
    },
    [channelId, markRead, actions, ports],
  );

  // What the last visit read and could not report is reported now.
  useEffect(() => {
    const waiting = owedOf(actions).get(channelId);
    if (member && waiting !== undefined) send(waiting, false);
  }, [member, channelId, actions, send]);

  useEffect(() => {
    if (!member || !atBottom || !visible || newestId === null) return undefined;
    reached.current = newestId;
    if (sent.current !== null && newestId <= sent.current) return undefined;
    return ports.schedule(() => {
      send(newestId);
    }, READ_DEBOUNCE_MS);
  }, [member, atBottom, visible, newestId, ports, send]);

  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
      retry.current?.();
      retry.current = null;
    };
  }, [channelId]);

  // Leaving the channel — or the page — reads what the person had reached.
  const leave = useRef(send);
  leave.current = send;
  useEffect(
    () => (): void => {
      // Left after "mark unread": it stays unread, and the next visit reads as usual.
      if (heldOf(actions).delete(channelId)) return;
      if (member && reached.current !== null) leave.current(reached.current, false);
    },
    [member, channelId, actions],
  );
};
