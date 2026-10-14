/**
 * Whether a person is in front of a workspace's page now (D-143): what holds a push back, since what
 * they are looking at already says it — the inbox, the badges, the title.
 *
 * A page says so while it is visible and focused, on the person's own input, at most every
 * `ACTIVE_EVERY_MS`; the person is active in that workspace while the last word is less than two of
 * those old, so one word missed by a slow socket does not end it. Ephemeral and in memory (D-7), like
 * typing: a restart forgets it, which costs at most one push that was not needed. On a second node a
 * word heard by the other is not known here (D-25), and a push goes — the quiet side of wrong.
 *
 * In platform rather than in the socket's registry: the push sender, a module, asks it.
 */
import { ACTIVE_EVERY_MS } from '@purlay/types';
import type { Clock } from './clock';

/** How long one word keeps a person active: two of the client's intervals. */
export const ACTIVE_WINDOW_MS = 2 * ACTIVE_EVERY_MS;

export interface Attention {
  /** The person said they are in front of this workspace's page. */
  readonly heard: (userId: string, workspaceId: string) => void;
  /** Whether they did, recently enough to hold a push for this workspace. */
  readonly active: (userId: string, workspaceId: string) => boolean;
}

/** What a test may ask beyond the interface: how many people are held. */
export interface InMemoryAttention extends Attention {
  readonly held: () => number;
}

export const inMemoryAttention = (clock: Clock): InMemoryAttention => {
  const lastHeard = new Map<string, number>();
  const keyOf = (userId: string, workspaceId: string): string => `${userId}:${workspaceId}`;
  // A word past its window is let go on the next call, wherever it is: memory is bounded by the
  // people active now, not by everyone who ever was.
  const sweep = (now: number): void => {
    for (const [key, at] of lastHeard) {
      if (now - at >= ACTIVE_WINDOW_MS) lastHeard.delete(key);
    }
  };
  return {
    heard: (userId, workspaceId): void => {
      const now = clock.now().getTime();
      sweep(now);
      lastHeard.set(keyOf(userId, workspaceId), now);
    },
    active: (userId, workspaceId): boolean => {
      const now = clock.now().getTime();
      sweep(now);
      return lastHeard.has(keyOf(userId, workspaceId));
    },
    held: (): number => lastHeard.size,
  };
};

/** Nobody is ever active: where nothing hears, every push goes (a job, a test that is not about it). */
export const nobodyActive: Attention = {
  heard: (): void => undefined,
  active: (): boolean => false,
};
