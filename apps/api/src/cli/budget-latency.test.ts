/**
 * The latency budget's arithmetic and its verdict (D-49, #73): a p95 by nearest rank, a regression only
 * past the factor and the noise floor, and what the command prints and keeps.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUDGETS, REGRESSION_FACTOR, judge, main, p95, type Latency } from './budget-latency';

const run = (ack: number, fanOut: number): Latency => ({
  ackP95Ms: ack,
  fanOutP95Ms: fanOut,
  messages: 60,
});

describe('the latency budget', () => {
  test('p95 is the nearest rank, and nothing measured is an error rather than a number', () => {
    expect(p95(Array.from({ length: 100 }, (_, n) => n + 1))).toBe(95);
    expect(p95([7])).toBe(7);
    expect(() => p95([])).toThrow('nothing was measured');
  });

  test('without a baseline it reports, with the budget beside each number, and never fails', () => {
    const { regressed, lines } = judge(run(20, BUDGETS.fanOutMs + 1), null);
    expect(regressed).toBe(false);
    expect(lines[0]).toBe('ACK round-trip p95: 20.0 ms of 120 ms (60 messages)');
    expect(lines[1]).toContain('over the budget');
  });

  test('a jump past the factor is a regression; at the factor, or under the noise floor, it is not', () => {
    const before = run(40, 40);
    expect(judge(run(40 * REGRESSION_FACTOR, 40), before).regressed).toBe(false);
    expect(judge(run(40 * REGRESSION_FACTOR + 0.1, 40), before).regressed).toBe(true);
    expect(judge(run(40, 40 * REGRESSION_FACTOR + 0.1), before).lines[1]).toContain('REGRESSED');
    // Four milliseconds becoming nineteen is noise on any machine, not a regression.
    expect(judge(run(19, 19), run(4, 4)).regressed).toBe(false);
  });

  test('the command keeps what it measured and fails on a regression against what it kept', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const first = await main(['--record', file], () => Promise.resolve(run(30, 30)));
    expect(first.code).toBe(0);
    expect(await Bun.file(file).json()).toEqual(run(30, 30));
    const worse = await main(['--baseline', file], () => Promise.resolve(run(100, 30)));
    expect(worse.code).toBe(1);
    expect(worse.lines[0]).toContain('was 30.0 ms) — REGRESSED');
  });
});
