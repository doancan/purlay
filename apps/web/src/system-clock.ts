/**
 * The browser's clock, read in exactly one place.
 *
 * Lint refuses a bare `new Date()` or `Date.now()` so that behaviour depending
 * on the time can be driven by a test (D-46). The client needs somewhere that
 * does read it, for the code that assembles it to hand to everything else as a
 * `Clock`; this is that place, and `eslint.config.mjs` exempts this file and no
 * other. `apps/web` cannot import the API's `platform/clock.ts`. (CONTRIBUTING §6.5)
 */
import type { Clock } from './realtime/clock';

export const systemClock: Clock = {
  now: (): Date => new Date(Date.now()),
};
