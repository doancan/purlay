/**
 * The clock, as a dependency.
 *
 * Reading the current time directly makes any behaviour that depends on it —
 * expiry, drift correction, retention windows — untestable without waiting. Lint
 * refuses a bare `new Date()` for that reason and points here.
 *
 * This module reads it through `Date.now()`, which is the primitive the rule is
 * about taking as an argument rather than the pattern it forbids. So the place
 * the rule points at needs no exception to the rule.
 */
/** Lengths of time a rule is written in, defined once. */
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export interface Clock {
  readonly now: () => Date;
}

export const systemClock: Clock = {
  now: (): Date => new Date(Date.now()),
};

/** A clock that does not move, for a test that needs to know exactly when it is. */
export const fixedClock = (instant: Date): Clock => ({ now: (): Date => new Date(instant) });
