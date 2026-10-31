/**
 * The latency budget's arithmetic and its verdict (D-49, #73): a p95 by nearest rank, a regression only
 * past the factor and the noise floor, and what the command prints and keeps.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUDGETS,
  REGRESSION_FACTOR,
  judge,
  main,
  p95,
  summarizeTrials,
  type Latency,
} from './budget-latency';

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
    expect(await Bun.file(file).json()).toEqual(
      summarizeTrials([run(30, 30), run(30, 30), run(30, 30)]),
    );
    const worse = await main(['--baseline', file], () => Promise.resolve(run(100, 30)));
    expect(worse.code).toBe(1);
    expect(worse.lines[0]).toContain('was 30.0 ms) — REGRESSED');
  });

  test('--keep compares with the file when there is one, says so when there is not, and keeps only a run that passed', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const first = await main(['--keep', file], () => Promise.resolve(run(30, 30)));
    expect(first.code).toBe(0);
    expect(first.lines[0]).toBe('no baseline yet: this run is recorded, nothing compared');
    expect(await Bun.file(file).json()).toEqual(
      summarizeTrials([run(30, 30), run(30, 30), run(30, 30)]),
    );
    const worse = await main(['--keep', file], () => Promise.resolve(run(100, 30)));
    expect(worse.code).toBe(1);
    // A regression is not adopted as the next run's baseline.
    expect(await Bun.file(file).json()).toEqual(
      summarizeTrials([run(30, 30), run(30, 30), run(30, 30)]),
    );
    const steady = await main(['--keep', file], () => Promise.resolve(run(32, 31)));
    expect(steady.code).toBe(0);
    expect(await Bun.file(file).json()).toEqual(
      summarizeTrials([run(32, 31), run(32, 31), run(32, 31)]),
    );
  });

  test('a baseline it cannot read, or an option with no file, is refused rather than compared with nothing', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    await Bun.write(file, '{}');
    const measure = (): Promise<Latency> => Promise.resolve(run(30, 30));
    const refusal = async (args: string[]): Promise<string> =>
      await main(args, measure).then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    expect(await refusal(['--keep', file])).toContain('is not a latency measurement');
    expect(await refusal(['--baseline', file])).toContain('is not a latency measurement');
    expect(await refusal(['--keep'])).toBe('--keep needs a value');
  });
});

describe('independent latency trials', () => {
  test('uses the middle p95 per metric, never the best run or a pooled percentile', () => {
    const trials = [run(35, 90), run(100, 32), run(30, 34)];
    expect(summarizeTrials(trials)).toEqual({
      ackP95Ms: 35,
      fanOutP95Ms: 34,
      messages: 60,
      trials,
    });
    expect(trials.map((trial) => trial.ackP95Ms)).toEqual([35, 100, 30]);
  });

  test('requires exactly three complete finite positive measurements', () => {
    for (const trials of [
      [],
      [run(30, 30)],
      [run(30, 30), run(30, 30)],
      Array.from({ length: 4 }, () => run(30, 30)),
      [run(30, 30), { ...run(30, 30), messages: 59 }, run(30, 30)],
      ...[0, -1, Number.NaN, Number.POSITIVE_INFINITY].flatMap((value) => [
        [run(30, 30), run(value, 30), run(30, 30)],
        [run(30, 30), run(30, value), run(30, 30)],
      ]),
    ])
      expect(() => summarizeTrials(trials)).toThrow('three complete');
  });

  test('runs all three trials even after a slow one, preserves raw results, and accepts one isolated stall', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    // Legacy single-run cache is still read and compared; it is never silently discarded.
    await Bun.write(file, JSON.stringify(run(30, 30)));
    const trials = [run(100, 100), run(31, 29), run(32, 30)];
    const calls: number[] = [];
    const result = await main(['--keep', file], (count) => {
      calls.push(count);
      return Promise.resolve(trials[calls.length - 1] ?? run(999, 999));
    });
    expect(calls).toEqual([60, 60, 60]);
    expect(result.code).toBe(0);
    expect(result.lines).toContain('verdict: median of three independent p95 measurements');
    expect(result.lines.join('\n')).toContain('trial 1/3: ACK p95 100.0 ms');
    expect(await Bun.file(file).json()).toEqual(summarizeTrials(trials));
  });

  test.each(['ack', 'fan-out'])(
    'a sustained %s slowdown fails and cannot replace the baseline',
    async (metric) => {
      const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
      const record = `${file}.current`;
      const original = JSON.stringify(run(30, 30));
      await Bun.write(file, original);
      const slow = metric === 'ack' ? run(100, 30) : run(30, 100);
      const trials = [slow, run(31, 31), slow];
      const again = [run(31, 31), slow, slow];
      let calls = 0;
      const result = await main(['--keep', file, '--record', record], () =>
        Promise.resolve([...trials, ...again][calls++] ?? run(999, 999)),
      );
      // Measured again once (D-227), and slow again: a sustained slowdown repeats.
      expect(calls).toBe(6);
      expect(result.code).toBe(1);
      expect(result.lines.join('\n')).toContain('REGRESSED');
      expect(await Bun.file(file).text()).toBe(original);
      expect(await Bun.file(record).json()).toEqual(summarizeTrials(again));
    },
  );

  test('an interrupted trial is an error, not a sample to discard or retry', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const original = JSON.stringify(run(30, 30));
    await Bun.write(file, original);
    let calls = 0;
    const refusal = await main(['--keep', file], () => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('socket disconnected'));
      return Promise.resolve(run(30, 30));
    }).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toBe('socket disconnected');
    expect(calls).toBe(2);
    expect(await Bun.file(file).text()).toBe(original);
  });
});

describe('a regression, measured again (D-227)', () => {
  /** A measure that answers these p95s in turn, and counts how many trials it was asked for. */
  const measuring = (
    answers: readonly Latency[],
  ): { readonly measure: () => Promise<Latency>; readonly calls: () => number } => {
    let calls = 0;
    return {
      measure: () => Promise.resolve(answers[calls++] ?? run(999, 999)),
      calls: () => calls,
    };
  };
  const slow = run(100, 30);
  const steady = run(31, 31);

  test('passes when three more trials hold, keeps and records them, and says both judgements', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const record = `${file}.current`;
    await Bun.write(file, JSON.stringify(run(30, 30)));
    const { measure, calls } = measuring([slow, slow, slow, steady, steady, steady]);
    const result = await main(['--keep', file, '--record', record], measure);
    expect(calls()).toBe(6);
    expect(result.code).toBe(0);
    const said = result.lines.join('\n');
    expect(said).toContain(
      'ACK round-trip p95: 100.0 ms of 120 ms (60 messages, was 30.0 ms) — REGRESSED',
    );
    expect(result.lines).toContain('first measurement regressed; measured again:');
    expect(said).toContain('ACK round-trip p95: 31.0 ms of 120 ms (60 messages, was 30.0 ms)\n');
    expect(await Bun.file(file).json()).toEqual(summarizeTrials([steady, steady, steady]));
    expect(await Bun.file(record).json()).toEqual(summarizeTrials([steady, steady, steady]));
  });

  test('fails a regression that repeats, records the second, and keeps nothing', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const record = `${file}.current`;
    const original = JSON.stringify(run(30, 30));
    await Bun.write(file, original);
    const second = run(90, 30);
    const { measure, calls } = measuring([slow, slow, slow, second, second, second]);
    const result = await main(['--keep', file, '--record', record], measure);
    expect(calls()).toBe(6);
    expect(result.code).toBe(1);
    expect(result.lines.filter((line) => line.endsWith('— REGRESSED'))).toHaveLength(2);
    expect(await Bun.file(file).text()).toBe(original);
    expect(await Bun.file(record).json()).toEqual(summarizeTrials([second, second, second]));
  });

  test('measures again only once, however the second set ends', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    await Bun.write(file, JSON.stringify(run(30, 30)));
    const { measure, calls } = measuring(Array.from({ length: 12 }, () => slow));
    expect((await main(['--keep', file], measure)).code).toBe(1);
    expect(calls()).toBe(6);
  });

  test('an interrupted trial while measuring again is an error, not a pass', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const original = JSON.stringify(run(30, 30));
    await Bun.write(file, original);
    let calls = 0;
    const refusal = await main(['--keep', file], () => {
      calls += 1;
      if (calls === 5) return Promise.reject(new Error('socket disconnected'));
      return Promise.resolve(calls <= 3 ? slow : steady);
    }).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toBe('socket disconnected');
    expect(await Bun.file(file).text()).toBe(original);
  });

  test('a run that passed the first time is not measured again', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    await Bun.write(file, JSON.stringify(run(30, 30)));
    const { measure, calls } = measuring([steady, steady, steady, slow, slow, slow]);
    expect((await main(['--keep', file], measure)).code).toBe(0);
    expect(calls()).toBe(3);
  });
});
