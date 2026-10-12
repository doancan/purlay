/**
 * The frame budget, measured (O-4, #61). D-66's numbers — ten frames a second, a burst of twenty —
 * are a guess until real use confirms them; this records, per connection, how many frames it sent,
 * the most in any one second, and how many the budget refused, for the socket's closing log line.
 * A week of those lines is the measurement O-4 names: the 99th percentile of the busiest second, and
 * refusals that must be zero for legitimate use.
 *
 * Seconds are the clock's whole seconds, not a sliding window: a peak that straddles two of them is
 * counted in halves, which errs low by at most half — enough to tell ten from forty.
 */
import type { Clock } from '../platform/clock';
import type { InProcessRateLimiter } from './rate-limiter';

interface FrameReport {
  readonly frames: number;
  readonly peakPerSecond: number;
  readonly refused: number;
}

interface Meter {
  second: number;
  inSecond: number;
  frames: number;
  peakPerSecond: number;
  refused: number;
}

export interface MeteredLimiter extends InProcessRateLimiter {
  /** What this connection has done, for its closing line. */
  readonly report: (key: string) => FrameReport;
}

export const metered = (inner: InProcessRateLimiter, clock: Clock): MeteredLimiter => {
  const meters = new Map<string, Meter>();
  return {
    consume: async (key, cost): Promise<boolean> => {
      const allowed = await inner.consume(key, cost);
      const second = Math.floor(clock.now().getTime() / 1000);
      const meter = meters.get(key) ?? {
        second,
        inSecond: 0,
        frames: 0,
        peakPerSecond: 0,
        refused: 0,
      };
      if (meter.second !== second) {
        meter.second = second;
        meter.inSecond = 0;
      }
      meter.inSecond += 1;
      meter.frames += 1;
      meter.peakPerSecond = Math.max(meter.peakPerSecond, meter.inSecond);
      if (!allowed) meter.refused += 1;
      meters.set(key, meter);
      return allowed;
    },
    forget: (key): void => {
      meters.delete(key);
      inner.forget(key);
    },
    held: (): number => inner.held(),
    report: (key): FrameReport => {
      const meter = meters.get(key);
      return meter === undefined
        ? { frames: 0, peakPerSecond: 0, refused: 0 }
        : { frames: meter.frames, peakPerSecond: meter.peakPerSecond, refused: meter.refused };
    },
  };
};
