/**
 * The latency gate against the noise a CI runner really makes: 80 runs of three trials, as the `schema` job
 * recorded them on identical code (`budget-latency-noise.ts`), compared in pairs, and the same pairs with a
 * slowdown injected into every trial of the second.
 */
import { describe, expect, test } from 'bun:test';
import { RECORDED_LOADED_FLOORS, RECORDED_RUNS } from './budget-latency-noise';
import { judge, summarizeTrials, type Latency } from './budget-latency';

/** Pairs compared: enough that 1% is a hundred pairs, not one. */
const PAIRS = 20_000;

/** A fixed seed: the same pairs every run, so a pass or a failure is not luck. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const runs: readonly (readonly Latency[])[] = RECORDED_RUNS.map((run) =>
  run.ack.map((ack, trial) => ({
    ackP95Ms: ack,
    fanOutP95Ms: run.fanOut[trial] ?? Number.NaN,
    messages: 60,
  })),
);

/** How many of `PAIRS` comparisons of one recorded run with another, the second slowed as `slow`, are regressions. */
const regressions = (slow: (value: number) => number): number => {
  const next = seeded(20261105);
  const pick = (): readonly Latency[] => runs[Math.floor(next() * runs.length)] ?? [];
  let regressed = 0;
  for (let pair = 0; pair < PAIRS; pair += 1) {
    const before = summarizeTrials(pick());
    const now = summarizeTrials(
      pick().map((trial) => ({
        ...trial,
        ackP95Ms: slow(trial.ackP95Ms),
        fanOutP95Ms: slow(trial.fanOutP95Ms),
      })),
    );
    if (judge(now, before).regressed) regressed += 1;
  }
  return regressed;
};

describe('the latency gate, against the noise CI recorded', () => {
  test('the recorded runs are what they were taken for: noisy, with trials from 10 to 70 ms', () => {
    expect(runs).toHaveLength(80);
    const acks = runs.flatMap((run) => run.map((trial) => trial.ackP95Ms));
    expect(Math.max(...acks)).toBeGreaterThan(60);
    expect(Math.min(...acks)).toBeLessThan(11);
  });

  test('identical code passes in at least 99% of comparisons, with the stalls the runners made', () => {
    expect(regressions((value) => value) / PAIRS).toBeLessThan(0.01);
  });

  test('a slowdown of 20 ms in every trial fails in at least 99% of comparisons', () => {
    expect(regressions((value) => value + 20) / PAIRS).toBeGreaterThan(0.99);
  });

  test('a tripling in every trial fails in at least 99% of comparisons', () => {
    expect(regressions((value) => value * 3) / PAIRS).toBeGreaterThan(0.99);
  });
});

describe('the rule for issues’ list with chat busy, against the noise CI’s runners made', () => {
  const chatTrials = (ms: number): readonly Latency[] =>
    Array.from({ length: 3 }, () => ({ ackP95Ms: ms, fanOutP95Ms: ms, messages: 60 }));
  const summary = (floor: number): ReturnType<typeof summarizeTrials> => ({
    ...summarizeTrials(chatTrials(30)),
    loaded: { 'issues/list': { p95Ms: floor, trials: [floor, floor, floor] } },
  });
  /** Every ordered pair of different measurements: the second, slowed as `slow`, judged against the first. */
  const pairs = (
    slow: (value: number) => number,
  ): { readonly regressed: number; readonly total: number } => {
    let regressed = 0;
    let total = 0;
    for (const [i, before] of RECORDED_LOADED_FLOORS.entries()) {
      for (const [j, now] of RECORDED_LOADED_FLOORS.entries()) {
        if (i === j) continue;
        total += 1;
        if (judge(summary(slow(now)), summary(before)).regressed) regressed += 1;
      }
    }
    return { regressed, total };
  };

  test('the measurements are what they were taken for: a floor that moved from 15 to 36 ms between runners', () => {
    expect(RECORDED_LOADED_FLOORS).toHaveLength(36);
    expect(Math.min(...RECORDED_LOADED_FLOORS)).toBeLessThan(16);
    expect(Math.max(...RECORDED_LOADED_FLOORS)).toBeGreaterThan(35);
  });

  test('identical code fails a single look in under 1% of pairs, which D-227’s second look then has to repeat', () => {
    const { regressed, total } = pairs((value) => value);
    expect(total).toBe(1260);
    expect(regressed / total).toBeLessThan(0.01);
  });

  test('a slowdown of 40 ms in every trial fails in at least 99% of pairs', () => {
    const { regressed, total } = pairs((value) => value + 40);
    expect(regressed / total).toBeGreaterThan(0.99);
  });

  test('a tripling in every trial fails in at least 90% of pairs', () => {
    const { regressed, total } = pairs((value) => value * 3);
    expect(regressed / total).toBeGreaterThan(0.9);
  });
});
