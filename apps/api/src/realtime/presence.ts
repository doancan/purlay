/**
 * Who is typing where (`ARCHITECTURE.md` §6.1). Ephemeral and in memory (D-7): lost on a restart,
 * which costs a listener at most one announcement's window.
 *
 * **What it decides is how often the room hears it.** A client announces while the person types;
 * the registry lets an announcement through when the person was not typing there, or when the last
 * one is half spent — so a listener's window is renewed before it runs out, and a client that
 * announces on every keystroke costs the room one frame per half window, not one per key.
 *
 * **A seam because a second node changes it** (D-25): two nodes each let one announcement through
 * for a person typing on both, which is a frame too many and never a wrong answer. With Redis the window
 * is shared (`redis-presence.ts`, D-201). Who is online is `online.ts`'s, which has its own shared form.
 */
import type { Clock } from '../platform/clock';

export interface PresenceRegistry {
  /**
   * Records the person typing here for `ttlMs`; true when the room should be told. Never throws. Answered
   * at once in process and after a round trip when shared (`redis-presence.ts`), so callers await it.
   */
  readonly startTyping: (
    channelId: string,
    userId: string,
    ttlMs: number,
  ) => boolean | Promise<boolean>;
  /**
   * Their message arrived: the window ends, and the next keystroke is announced at once. Not waited for,
   * so a send's answer never waits on it; shared, it is a best effort and the window ends by itself.
   */
  readonly stopTyping: (channelId: string, userId: string) => void;
}

/** What a test may ask beyond the interface: how many windows are held. */
export interface InMemoryPresenceRegistry extends PresenceRegistry {
  readonly startTyping: (channelId: string, userId: string, ttlMs: number) => boolean;
  readonly held: () => number;
}

interface Window {
  readonly announcedAt: number;
  readonly endsAt: number;
}

export const inMemoryPresenceRegistry = (clock: Clock): InMemoryPresenceRegistry => {
  const windows = new Map<string, Window>();
  const keyOf = (channelId: string, userId: string): string => `${channelId}:${userId}`;
  // Ended windows are let go on the next call, wherever they are: a channel typed in once and
  // never again must not be held for the life of the process. Bounded by the people typing now.
  const sweep = (now: number): void => {
    for (const [key, window] of windows) {
      if (window.endsAt <= now) windows.delete(key);
    }
  };

  return {
    startTyping: (channelId, userId, ttlMs): boolean => {
      const now = clock.now().getTime();
      sweep(now);
      const key = keyOf(channelId, userId);
      const current = windows.get(key);
      if (current !== undefined && now - current.announcedAt < ttlMs / 2) return false;
      windows.set(key, { announcedAt: now, endsAt: now + ttlMs });
      return true;
    },
    stopTyping: (channelId, userId): void => {
      windows.delete(keyOf(channelId, userId));
      sweep(clock.now().getTime());
    },
    held: (): number => windows.size,
  };
};
