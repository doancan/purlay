/**
 * How long to wait before the next reconnect attempt (`ARCHITECTURE.md` §5.4).
 *
 * Exponential from one second, capped at thirty, so a server that is down is
 * not hammered. Jittered, because every client of a server that restarted lost
 * its connection at the same instant: without jitter they all come back at 1 s,
 * then all at 2 s, and the server meets the whole room in lockstep. (D-76)
 */
export const BACKOFF = { baseMs: 1_000, capMs: 30_000 } as const;

/**
 * `attempt` is the number of failures so far: 0 for the first retry.
 *
 * The delay is somewhere in the upper half of the exponential step — never near
 * zero. Full jitter (anywhere from 0) spreads clients most evenly, and it also
 * lets one client retry immediately, several times in a row, against a server
 * that is refusing it. `random` is an argument so a test names the draw.
 */
export const reconnectDelay = (attempt: number, random: () => number): number => {
  const step = Math.min(BACKOFF.capMs, BACKOFF.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(step / 2 + (random() * step) / 2);
};
