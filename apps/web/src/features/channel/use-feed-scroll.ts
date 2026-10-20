/**
 * The feed's scroll behaviour (`UX.md` §6): the rules, as one hook.
 *
 * - **Anchor on read position, not on the bottom.** A reader scrolled up is not moved by
 *   anything arriving below, and older pages loaded above do not move them either
 *   (`restoreAfterPrepend`). A "N new messages ↓" pill says what is waiting.
 * - **Stick to the bottom only when already at the bottom** (within 80px) — and always
 *   after the person's own send, which they expect to see.
 * - **A channel opens where the reader's place is**: at the unread marker when there is
 *   one, at the bottom when there is not.
 * - **It keeps its place when the box around it changes size** — the composer growing a
 *   line, a late-arriving highlight — while at the bottom.
 *
 * What is measured and what is observed come through `FeedPorts`, so a test sets the
 * numbers an element would have and fires the observers by hand.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { FeedItem } from './feed-model';
import type { FeedPorts } from './feed-ports';
import {
  MARKER_MARGIN_PX,
  holdAnchor,
  isNearBottom,
  readAnchor,
  restoreAfterPrepend,
  scrollToBottom,
  type Anchor,
} from './scroll';
import { isMine } from '../messages/author';

export interface FeedScroll {
  /** Is the reader at the bottom right now? */
  readonly atBottom: boolean;
  /** How many messages from other people arrived below while the reader was scrolled up. */
  readonly newBelow: number;
  readonly onScroll: () => void;
  readonly jumpToBottom: () => void;
  /**
   * The reader is about to change the height of what is below them on purpose (a thread
   * opening), and does not want to be carried to the bottom by it.
   */
  readonly holdPlace: () => void;
  /**
   * Newer history is about to be read in below, in a window around a linked message (D-149): it
   * is what the reader scrolled down to, not news — the reader is neither carried to the new
   * bottom nor told of it by the pill.
   */
  readonly extendBelow: () => void;
}

interface Options {
  readonly scroller: React.RefObject<HTMLElement | null>;
  readonly content: React.RefObject<HTMLElement | null>;
  readonly items: readonly FeedItem[];
  /** The first page is in: until then there is nothing to place the reader in. */
  readonly ready: boolean;
  readonly meId: string;
  readonly ports: FeedPorts;
}

const messageIds = (items: readonly FeedItem[]): { first: string | null; last: string | null } => {
  let first: string | null = null;
  let last: string | null = null;
  for (const item of items) {
    if (item.kind !== 'message') continue;
    first ??= item.message.id;
    last = item.message.id;
  }
  return { first, last };
};

export const useFeedScroll = ({
  scroller,
  content,
  items,
  ready,
  meId,
  ports,
}: Options): FeedScroll => {
  // The scroller and its content exist only once there is something to show; the observers
  // below must attach when they appear, not when the hook first runs.
  const showing = ready && items.length > 0;
  // False until the reader has been placed: a read position must not be sent on a guess made before layout.
  const [atBottom, setAtBottom] = useState(false);
  const [newBelow, setNewBelow] = useState(0);
  // Set by `holdPlace` until the reader is next placed or scrolls: what changes below is theirs.
  const held = useRef(false);
  // Set by `extendBelow` until the rows it asked for are in.
  const extending = useRef(false);
  const placed = useRef(false);
  const before = useRef({
    first: null as string | null,
    last: null as string | null,
    top: 0,
    height: 0,
    client: 0,
    anchor: null as Anchor | null,
  });

  const settle = useCallback((el: HTMLElement): void => {
    const near = isNearBottom(el);
    held.current = false;
    setAtBottom(near);
    if (near) setNewBelow(0);
  }, []);

  /**
   * Whether the reader was at the bottom before this change — measured now, not taken from
   * the last scroll report. A browser reports a scroll on the next frame, and under load a
   * message can land first: the report would still say "at the bottom" and the reader who had
   * just scrolled up would be carried down. The position is current; the heights are the ones
   * the content and the box had before the change.
   */
  const wasAtBottom = (el: HTMLElement): boolean =>
    !held.current &&
    isNearBottom({
      scrollTop: el.scrollTop,
      scrollHeight: before.current.height,
      clientHeight: before.current.client,
    });

  /** The place a later change is measured from: where the reader is now. */
  const remember = (el: HTMLElement, ids: { first: string | null; last: string | null }): void => {
    before.current = {
      ...ids,
      top: el.scrollTop,
      height: el.scrollHeight,
      client: el.clientHeight,
      anchor: readAnchor(el),
    };
  };

  const onScroll = useCallback((): void => {
    const el = scroller.current;
    if (el === null) return;
    // A scroll the reader did not make upward, from a place that was the bottom, keeps them there.
    // The report of our own move to the bottom can arrive after the list grew under it — a picture
    // drawn a frame later — and would otherwise be taken as the reader having stopped above the end.
    const previous = before.current;
    const movedUp = el.scrollTop < previous.top - 1;
    if (
      !movedUp &&
      !held.current &&
      isNearBottom({
        scrollTop: previous.top,
        scrollHeight: previous.height,
        clientHeight: previous.client,
      })
    ) {
      scrollToBottom(el);
    }
    settle(el);
    // Where the reader is *now* is what a later prepend must give back to them.
    remember(el, before.current);
  }, [scroller, settle]);

  const jumpToBottom = useCallback((): void => {
    const el = scroller.current;
    if (el === null) return;
    scrollToBottom(el);
    settle(el);
  }, [scroller, settle]);

  // Runs after every change to the list, before the browser paints it.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null || !ready) return;
    const { first, last } = messageIds(items);
    const previous = before.current;

    if (!placed.current) {
      // Opening: the marker if there is one, else the bottom.
      const marker = el.querySelector<HTMLElement>('[data-feed-marker]');
      if (marker === null) scrollToBottom(el);
      else el.scrollTop = Math.max(0, marker.offsetTop - MARKER_MARGIN_PX);
      placed.current = true;
      settle(el);
    } else if (previous.first !== null && first !== null && first < previous.first) {
      // Older messages arrived above the reader.
      restoreAfterPrepend(el, { scrollTop: previous.top, scrollHeight: previous.height });
      // The height added above says where the reader is only if nothing below it changed: the row
      // they were on can be shorter now (it follows a message by the same person).
      holdAnchor(el, previous.anchor);
      settle(el);
    } else if (last !== previous.last && extending.current) {
      // Read in below on purpose: the reader stays where they are, and none of it is "new".
      extending.current = false;
      settle(el);
    } else if (last !== previous.last) {
      const newest = [...items].reverse().find((item) => item.kind === 'message');
      const own = newest !== undefined && isMine(newest.message, meId);
      if (own || wasAtBottom(el)) {
        scrollToBottom(el);
        settle(el);
      } else {
        const arrived = items.filter(
          (item) =>
            item.kind === 'message' &&
            previous.last !== null &&
            item.message.id > previous.last &&
            !isMine(item.message, meId),
        ).length;
        setNewBelow((count) => count + arrived);
        // The scroll that put them here may not be reported yet; the pill, and whether this
        // counts as read, follow the place measured now.
        settle(el);
      }
    } else if (wasAtBottom(el)) {
      // Nothing new, but a row changed in place — its pictures drawn, its words edited longer. A
      // reader who was at the bottom is kept there, judged by the height before the change: the
      // resize that follows would otherwise measure from the taller list remembered below and
      // leave them a picture's height above the end.
      scrollToBottom(el);
      settle(el);
    }
    remember(el, { first, last });
  }, [items, ready, meId, scroller, settle]);

  // The box around the feed or the content inside it changed size: a reader at the bottom stays there.
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (el === null || inner === null) return undefined;
    return ports.whenResized([el, inner], () => {
      if (wasAtBottom(el)) scrollToBottom(el);
      remember(el, before.current);
    });
  }, [scroller, content, ports, showing]);

  const holdPlace = useCallback((): void => {
    held.current = true;
  }, []);

  const extendBelow = useCallback((): void => {
    extending.current = true;
  }, []);

  return { atBottom, newBelow, onScroll, jumpToBottom, holdPlace, extendBelow };
};
