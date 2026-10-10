/**
 * What the feed reaches outside React for: observers, timers, the clock, the page's
 * visibility.
 *
 * The rules of `UX.md` §6 are about scrolling, and scrolling is the browser's. So the
 * browser's observers are *ports*: the feed asks to be told when its top sentinel comes
 * into view, when the content or the viewport changes size, when the page is hidden or
 * shown; a test hands it functions it fires by hand, and nothing in a component test waits
 * for a layout engine that the test DOM does not have. The browser's own are the defaults.
 */
import { createContext, useContext } from 'react';
import type { Clock } from '../../realtime/clock';
import type { Schedule } from '../../realtime/connection';
import { browserSchedule } from '../../realtime/socket';
import { systemClock } from '../../system-clock';

export interface FeedPorts {
  /** Calls back each time `target` is visible inside `root`; returns how to stop. */
  readonly whenVisible: (target: Element, root: Element, onVisible: () => void) => () => void;
  /** Calls back whenever any of the elements changes size; returns how to stop. */
  readonly whenResized: (targets: readonly Element[], onResize: () => void) => () => void;
  /** Is the page in front of the person right now? */
  readonly pageVisible: () => boolean;
  /** Calls back when the page is shown or hidden; returns how to stop. */
  readonly onPageVisibility: (listener: () => void) => () => void;
  readonly schedule: Schedule;
  readonly clock: Clock;
}

const browserPorts: FeedPorts = {
  whenVisible: (target, root, onVisible) => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onVisible();
      },
      { root },
    );
    observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  },
  whenResized: (targets, onResize) => {
    const observer = new ResizeObserver(onResize);
    for (const target of targets) observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  },
  pageVisible: () => document.visibilityState === 'visible',
  onPageVisibility: (listener) => {
    document.addEventListener('visibilitychange', listener);
    return (): void => {
      document.removeEventListener('visibilitychange', listener);
    };
  },
  schedule: browserSchedule,
  clock: systemClock,
};

export const FeedPortsContext = createContext<FeedPorts>(browserPorts);

export const useFeedPorts = (): FeedPorts => useContext(FeedPortsContext);
