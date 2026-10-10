/**
 * The browser's outside world, replaced by things a test can touch.
 *
 * Each of these is an argument somewhere in the application (D-46): storage,
 * history, the timer, the operating system's colour scheme. A test that wants a
 * dropped connection, a toast that times out or a person who prefers dark does not
 * wait for one and does not reach into `window`; it holds the fake.
 */
import type { HistoryPort } from '../router/router';
import type { DarkQuery } from '../theme/theme';
import type { Schedule } from '../realtime/connection';

export interface MemoryStorage {
  readonly data: Record<string, string>;
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export const memoryStorage = (initial: Readonly<Record<string, string>> = {}): MemoryStorage => {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key): string | null => data[key] ?? null,
    setItem: (key, value): void => {
      data[key] = value;
    },
  };
};

/** A history that is an array, with Back. */
export interface FakeHistory extends HistoryPort {
  readonly stack: string[];
  readonly back: () => void;
  /** How many listeners are attached right now. */
  readonly listeners: () => number;
}

export const fakeHistory = (start = '/'): FakeHistory => {
  const stack = [start];
  const listeners = new Set<() => void>();
  const split = (url: string): { pathname: string; search: string } => {
    const [pathname = '/', search = ''] = url.split('?');
    return { pathname, search: search === '' ? '' : `?${search}` };
  };
  return {
    stack,
    listeners: (): number => listeners.size,
    read: () => split(stack[stack.length - 1] ?? '/'),
    push: (url): void => {
      stack.push(url);
    },
    replace: (url): void => {
      stack[stack.length - 1] = url;
    },
    listen: (listener): (() => void) => {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    back: (): void => {
      stack.pop();
      for (const listener of listeners) listener();
    },
  };
};

/** Time that moves only when told to. */
export interface FakeSchedule {
  readonly schedule: Schedule;
  /** Moves time forward and runs everything that came due, in order. */
  readonly advance: (ms: number) => void;
  /** How many timers are waiting. */
  readonly pending: () => number;
}

export const fakeSchedule = (): FakeSchedule => {
  let now = 0;
  const entries: { at: number; run: () => void; live: boolean }[] = [];
  return {
    schedule: (run, ms) => {
      const entry = { at: now + ms, run, live: true };
      entries.push(entry);
      return (): void => {
        entry.live = false;
      };
    },
    advance: (ms): void => {
      now += ms;
      for (const entry of entries.filter((candidate) => candidate.live && candidate.at <= now)) {
        entry.live = false;
        entry.run();
      }
    },
    pending: (): number => entries.filter((entry) => entry.live).length,
  };
};

/** The operating system's colour scheme, which the test can change its mind about. */
export interface FakeColourScheme extends DarkQuery {
  matches: boolean;
  readonly flip: (dark: boolean) => void;
}

export const fakeColourScheme = (dark = false): FakeColourScheme => {
  const listeners = new Set<() => void>();
  const query: FakeColourScheme = {
    matches: dark,
    addEventListener: (_type, listener): void => {
      listeners.add(listener);
    },
    removeEventListener: (_type, listener): void => {
      listeners.delete(listener);
    },
    flip: (next): void => {
      query.matches = next;
      for (const listener of listeners) listener();
    },
  };
  return query;
};
