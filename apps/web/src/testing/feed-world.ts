/**
 * The feed's outside world, in a test's hands: scroll measurements, observers that fire when
 * told, a page that can be hidden, and time that moves only when it is.
 *
 * The test DOM has no layout, so a scroller has no height. `installScrollMetrics` gives
 * every feed scroller (found by its `overflow-y-auto` class) the numbers a test sets, and
 * records each position the code assigns — so "it scrolled to the bottom" and "it gave the
 * reader their place back" are assertions on numbers, not on a browser. What still needs
 * a real browser (does native scroll anchoring agree? does the pill appear in view?) is
 * left to Playwright and said so in the tests that stop here.
 */
import { fakeSchedule, type FakeSchedule } from './fakes';
import type { FeedPorts } from '../features/channel/feed-ports';

export interface ScrollMetrics {
  scrollHeight: number;
  clientHeight: number;
  /** `offsetTop` of the unread marker. */
  markerTop: number;
  /** Every `scrollTop` the code under test assigned, in order. */
  readonly assigned: number[];
  /** The position now; assigning updates it, a test can set it to simulate the reader scrolling. */
  top: number;
}

const isScroller = (el: Element): boolean => el.className.includes('overflow-y-auto');

/** Replaces the layout properties of a feed scroller; returns the numbers to drive and how to undo it. */
export const installScrollMetrics = (): { metrics: ScrollMetrics; restore: () => void } => {
  const metrics: ScrollMetrics = {
    scrollHeight: 0,
    clientHeight: 0,
    markerTop: 0,
    assigned: [],
    top: 0,
  };
  const proto = HTMLElement.prototype;
  const originals = ['scrollHeight', 'clientHeight', 'scrollTop', 'offsetTop'].map(
    (name) => [name, Object.getOwnPropertyDescriptor(proto, name)] as const,
  );
  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isScroller(this) ? metrics.scrollHeight : 0;
    },
  });
  Object.defineProperty(proto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      return isScroller(this) ? metrics.clientHeight : 0;
    },
  });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement): number {
      return isScroller(this) ? metrics.top : 0;
    },
    set(this: HTMLElement, value: number) {
      if (!isScroller(this)) return;
      const clamped = Math.max(0, Math.min(value, metrics.scrollHeight - metrics.clientHeight));
      metrics.assigned.push(clamped);
      metrics.top = clamped;
    },
  });
  Object.defineProperty(proto, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement): number {
      return this.hasAttribute('data-feed-marker') ? metrics.markerTop : 0;
    },
  });
  return {
    metrics,
    restore: (): void => {
      for (const [name, descriptor] of originals) {
        if (descriptor === undefined) Reflect.deleteProperty(proto, name);
        else Object.defineProperty(proto, name, descriptor);
      }
    },
  };
};

export interface FeedWorld {
  readonly ports: FeedPorts;
  readonly timers: FakeSchedule;
  /** The top sentinel came into view. */
  readonly sentinelVisible: () => void;
  /**
   * The top row is on screen and stays there, as it is for a short channel or a reader parked
   * at the top. A real `IntersectionObserver` reports "visible" the moment it is set up and
   * again every time it is set up anew, which is how a failing page turns into a loop; this
   * makes the fake do the same (in a microtask, as the real one does).
   */
  stayInView: boolean;
  /** The scroller or its content changed size. */
  readonly resize: () => void;
  /** The page was hidden or shown. */
  readonly setPageVisible: (visible: boolean) => void;
  /** What time it is, as the feed reads it. */
  readonly clock: { now: Date };
  /** How many times each observer was set up and torn down — a leak is a number that does not match. */
  readonly live: { visible: number; resized: number; visibility: number };
}

export const feedWorld = (start = new Date(Date.UTC(2026, 8, 9, 12, 0, 0))): FeedWorld => {
  const timers = fakeSchedule();
  const clock = { now: start };
  const visible = new Set<() => void>();
  const resized = new Set<() => void>();
  const visibility = new Set<() => void>();
  let shown = true;
  const live = { visible: 0, resized: 0, visibility: 0 };
  const world: FeedWorld = {
    stayInView: false,
    timers,
    clock,
    live,
    ports: {
      whenVisible: (_target, _root, onVisible) => {
        visible.add(onVisible);
        live.visible += 1;
        if (world.stayInView) {
          queueMicrotask(() => {
            if (visible.has(onVisible)) onVisible();
          });
        }
        return (): void => {
          visible.delete(onVisible);
          live.visible -= 1;
        };
      },
      whenResized: (_targets, onResize) => {
        resized.add(onResize);
        live.resized += 1;
        return (): void => {
          resized.delete(onResize);
          live.resized -= 1;
        };
      },
      pageVisible: () => shown,
      onPageVisibility: (listener) => {
        visibility.add(listener);
        live.visibility += 1;
        return (): void => {
          visibility.delete(listener);
          live.visibility -= 1;
        };
      },
      schedule: timers.schedule,
      clock: { now: () => clock.now },
    },
    sentinelVisible: (): void => {
      for (const listener of visible) listener();
    },
    resize: (): void => {
      for (const listener of resized) listener();
    },
    setPageVisible: (next): void => {
      shown = next;
      for (const listener of visibility) listener();
    },
  };
  return world;
};
