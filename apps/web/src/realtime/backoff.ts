import { BACKOFF } from '@purlay/types';

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
