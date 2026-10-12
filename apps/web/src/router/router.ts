/**
 * Where the page is, and moving it — the History API behind a port.
 *
 * `HistoryPort` is the four things this needs from the browser; the real one is
 * `browserHistory()` and a test hands in an array. Everything else is a plain
 * store that `useSyncExternalStore` can read, so a navigation re-renders exactly
 * what asked where it is.
 *
 * **A snapshot is the same object until the location changes.** React compares
 * snapshots by identity; building a fresh one on every read would make every
 * subscriber re-render on every render.
 */
import { markRoute } from '../app/switch-timing';
import { matchRoute, type Match } from './routes';

export interface HistoryPort {
  readonly read: () => { readonly pathname: string; readonly search: string };
  readonly push: (url: string) => void;
  readonly replace: (url: string) => void;
  /** Calls `listener` when the person goes back or forward; returns how to stop. */
  readonly listen: (listener: () => void) => () => void;
}

export const browserHistory = (): HistoryPort => ({
  read: () => ({ pathname: window.location.pathname, search: window.location.search }),
  push: (url): void => {
    window.history.pushState(null, '', url);
  },
  replace: (url): void => {
    window.history.replaceState(null, '', url);
  },
  listen: (listener): (() => void) => {
    window.addEventListener('popstate', listener);
    return (): void => {
      window.removeEventListener('popstate', listener);
    };
  },
});

export interface Location {
  readonly pathname: string;
  readonly search: string;
  readonly match: Match;
}

export interface NavigateOptions {
  /** Replace the current entry instead of adding one: for redirects, which Back must not return to. */
  readonly replace?: boolean;
}

export interface Router {
  readonly getSnapshot: () => Location;
  readonly subscribe: (onChange: () => void) => () => void;
  readonly navigate: (url: string, options?: NavigateOptions) => void;
}

export const createRouter = (history: HistoryPort): Router => {
  const listeners = new Set<() => void>();
  const locate = (): Location => {
    const { pathname, search } = history.read();
    return { pathname, search, match: matchRoute(pathname) };
  };
  let current = locate();

  const refresh = (): void => {
    const next = locate();
    if (next.pathname === current.pathname && next.search === current.search) return;
    current = next;
    // Where a channel switch begins, for the feed to measure to (O-5).
    markRoute();
    for (const listener of listeners) listener();
  };

  // Listening to the browser costs something and is only worth it while somebody
  // is reading the location; a router nobody reads holds no listener.
  let stopListening: (() => void) | null = null;

  return {
    getSnapshot: () => current,
    subscribe: (onChange): (() => void) => {
      stopListening ??= history.listen(refresh);
      listeners.add(onChange);
      // Back and forward may have been pressed while nobody was subscribed.
      refresh();
      return (): void => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          stopListening?.();
          stopListening = null;
        }
      };
    },
    navigate: (url, options): void => {
      if (options?.replace === true) history.replace(url);
      else history.push(url);
      refresh();
    },
  };
};
