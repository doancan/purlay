/**
 * The latency budget's arithmetic and its verdict (D-49, #73): a p95 by nearest rank, a regression only
 * past the factor and the noise floor, and what the command prints and keeps.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundledModules } from '../composition';
import {
  BUDGETS,
  HOT_PATHS,
  type LoadedMeasure,
  STARVATION_FACTOR,
  requireAnswers,
  gate,
  countAnswer,
  lowestOf,
  REGRESSION_FACTOR,
  FLOOR_SPREAD_MS,
  judge,
  limitOf,
  spreadOf,
  main,
  p95,
  summarizeTrials,
  withIssuesBusy,
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

  test('what a number may be is the most of the factor, the floor’s spread and the noise floor, and nothing past it passes', () => {
    expect(limitOf(40)).toBe(40 * REGRESSION_FACTOR);
    // At 16 ms the factor allows 24 and the spread of the floor allows 26: the larger is the limit.
    expect(limitOf(16)).toBe(16 + FLOOR_SPREAD_MS);
    expect(limitOf(4)).toBe(20);
    expect(limitOf(25, STARVATION_FACTOR)).toBe(25 * STARVATION_FACTOR);
    // At 40 ms, a half as much again is a regression the spread of the floor does not excuse.
    expect(judge(run(60.1, 40), run(40, 40)).regressed).toBe(true);
    // At 16 ms, one runner being 10 ms slower than another is the spread, and 10.1 is not.
    expect(judge(run(16 + FLOOR_SPREAD_MS, 16), run(16, 16)).regressed).toBe(false);
    expect(judge(run(16 + FLOOR_SPREAD_MS + 0.1, 16), run(16, 16)).regressed).toBe(true);
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
    expect(worse.lines[0]).toContain('was 30.0 ms, limit 45.0 ms) — REGRESSED');
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
  test('judges the lowest p95 per metric, never a pooled percentile, and keeps every trial', () => {
    const trials = [run(35, 90), run(100, 32), run(30, 34)];
    expect(summarizeTrials(trials)).toEqual({
      ackP95Ms: 30,
      fanOutP95Ms: 32,
      messages: 60,
      trials,
    });
    expect(trials.map((trial) => trial.ackP95Ms)).toEqual([35, 100, 30]);
  });

  test('says how noisy the trials were', () => {
    expect(spreadOf([run(17, 20), run(93, 21), run(30.7, 19)])).toBe(
      'noise across 3 trials: ACK p95 17.0 to 93.0 ms, fan-out p95 19.0 to 21.0 ms',
    );
  });

  test('the trials of the failed jobs on record pass against the baseline they failed, and say how noisy they were', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    await Bun.write(file, JSON.stringify(run(16.4, 16.4)));
    const trials = [run(30.7, 30.5), run(17, 17), run(93, 92)];
    let calls = 0;
    const result = await main(['--keep', file], () =>
      Promise.resolve(trials[calls++] ?? run(999, 999)),
    );
    expect(result.code).toBe(0);
    expect(calls).toBe(3);
    expect(result.lines).toContain(
      'noise across 3 trials: ACK p95 17.0 to 93.0 ms, fan-out p95 17.0 to 92.0 ms',
    );
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
    expect(result.lines).toContain('verdict: lowest of three independent p95 measurements');
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
      const trials = [slow, slow, slow];
      const again = [slow, slow, slow];
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
      'ACK round-trip p95: 100.0 ms of 120 ms (60 messages, was 30.0 ms, limit 45.0 ms) — REGRESSED',
    );
    expect(result.lines).toContain('first measurement regressed; measured again:');
    expect(said).toContain(
      'ACK round-trip p95: 31.0 ms of 120 ms (60 messages, was 30.0 ms, limit 45.0 ms)\n',
    );
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

describe('chat’s latency with issues busy', () => {
  const quiet = run(25, 25);
  /** A trial with people reading issues all the while: answered some, refused some. */
  const busy = (ack: number, fanOut: number): Latency => ({
    ...run(ack, fanOut),
    issues: { answered: 900, refused: 12 },
  });
  const measuring = (
    answers: readonly Latency[],
  ): {
    readonly measure: (count: number, issuesBusy: boolean) => Promise<Latency>;
    readonly asked: { count: number; issuesBusy: boolean }[];
  } => {
    const asked: { count: number; issuesBusy: boolean }[] = [];
    return {
      asked,
      measure: (count, issuesBusy): Promise<Latency> => {
        asked.push({ count, issuesBusy });
        return Promise.resolve(answers[asked.length - 1] ?? busy(999, 999));
      },
    };
  };

  test('asks for two trials of sixty messages with issues busy, judges the lower, and passes when chat holds', async () => {
    const { measure, asked } = measuring([busy(31, 26), busy(29, 28)]);
    const verdict = await withIssuesBusy(quiet, measure);
    expect(asked).toEqual(Array.from({ length: 2 }, () => ({ count: 60, issuesBusy: true })));
    expect(verdict.regressed).toBe(false);
    expect(verdict.lines[0]).toBe('with issues busy, against the quiet trials of this run:');
    expect(verdict.lines[1]).toBe(
      'ACK round-trip p95: 29.0 ms of 120 ms (60 messages, was 25.0 ms, limit 200.0 ms)',
    );
    expect(verdict.lines.join('\n')).toContain('issues answered 900, refused 12');
  });

  test('starvation, past the factor of the quiet trials, is measured again once, and fails if it repeats', async () => {
    const slow = busy(250, 250);
    const { measure, asked } = measuring(Array.from({ length: 4 }, () => slow));
    const verdict = await withIssuesBusy(quiet, measure);
    expect(asked).toHaveLength(4);
    expect(verdict.regressed).toBe(true);
    expect(verdict.lines).toContain(
      'first measurement with issues busy regressed; measured again:',
    );
    expect(verdict.lines.filter((line) => line.endsWith('— REGRESSED'))).toHaveLength(4);
  });

  test('passes when the second look holds, even at a few times the quiet p95', async () => {
    const slow = busy(250, 250);
    const fine = busy(70, 70);
    const { measure, asked } = measuring([slow, slow, fine, fine]);
    const verdict = await withIssuesBusy(quiet, measure);
    expect(asked).toHaveLength(4);
    expect(verdict.regressed).toBe(false);
  });

  test('is an error, not a pass, when nobody was answered while issues were meant to be busy', async () => {
    for (const issues of [undefined, { answered: 0, refused: 0 }]) {
      const { measure } = measuring([
        { ...run(27, 27), ...(issues === undefined ? {} : { issues }) },
      ]);
      const refusal = await withIssuesBusy(quiet, measure).then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refusal).toContain('nobody was answered');
    }
  });

  test('one starved trial among two is not starvation, since the lower is what is judged', async () => {
    const { measure, asked } = measuring([busy(250, 250), busy(70, 70)]);
    expect((await withIssuesBusy(quiet, measure)).regressed).toBe(false);
    expect(asked).toHaveLength(2);
  });

  test('the factor is judged on the ratio to the quiet p95, with the noise floor under it', async () => {
    const verdictFor = async (quietMs: number, busyMs: number): Promise<boolean> => {
      const { measure } = measuring(Array.from({ length: 4 }, () => busy(busyMs, busyMs)));
      return (await withIssuesBusy(run(quietMs, quietMs), measure)).regressed;
    };
    // Just under and just over eight times a quiet 25 ms.
    expect(await verdictFor(25, 25 * STARVATION_FACTOR - 0.1)).toBe(false);
    expect(await verdictFor(25, 25 * STARVATION_FACTOR + 0.1)).toBe(true);
    // A quiet 1 ms makes eight times 8 ms, which is noise: only the floor of 20 ms counts.
    expect(await verdictFor(1, 19.9)).toBe(false);
    expect(await verdictFor(1, 20.1)).toBe(true);
  });

  test('says the ratio to the quiet p95 and the factor that is starvation', async () => {
    const { measure } = measuring([busy(50, 75), busy(60, 80)]);
    const verdict = await withIssuesBusy(quiet, measure);
    expect(verdict.lines).toContain(
      'ratio to the quiet p95: ACK 2.0x, fan-out 3.0x; starved past 8x',
    );
  });

  test('counts an answer and a refusal of the share, and refuses to count anything else', () => {
    const tally = { answered: 0, refused: 0 };
    countAnswer(tally, 200);
    countAnswer(tally, 200);
    countAnswer(tally, 503);
    expect(tally).toEqual({ answered: 2, refused: 1 });
    expect(() => {
      countAnswer(tally, 500);
    }).toThrow('issues answered 500');
    expect(tally).toEqual({ answered: 2, refused: 1 });
  });

  test('the lower p95 of each metric is taken separately', () => {
    expect(lowestOf([run(40, 20), run(30, 50)])).toEqual(run(30, 20));
  });

  test('the command hands back what the quiet trials came to, to be judged against', async () => {
    const result = await main([], () => Promise.resolve(run(30, 31)));
    expect(result.quiet).toEqual(summarizeTrials([run(30, 31), run(30, 31), run(30, 31)]));
  });
});

describe('a trial that was not answered', () => {
  test('is an error unless every message was answered and delivered', () => {
    requireAnswers(60, 60, 60);
    expect(() => {
      requireAnswers(59, 60, 60);
    }).toThrow('answers missing: 59 ACKs and 60 deliveries of 60');
    expect(() => {
      requireAnswers(60, 0, 60);
    }).toThrow('answers missing');
  });
});

/** Chat's senders, answered while issues' list was timed. */
const BUSY = { answered: 100, refused: 3 };

/** The p95 a module's hot path is answered while the others are busy, one value for the one metric each has here. */
const loadedAt = (...answers: number[]): LoadedMeasure => {
  return () => Promise.resolve({ p95: { list: answers.shift() ?? 999 }, busy: { chat: BUSY } });
};

describe('the whole gate', () => {
  const quietOrBusy =
    (quiet: Latency, busy: Latency) =>
    (_count: number, issuesBusy: boolean): Promise<Latency> =>
      Promise.resolve(issuesBusy ? { ...busy, issues: { answered: 100, refused: 0 } } : quiet);

  test('passes when the quiet trials and the trials with issues busy both hold', async () => {
    const result = await gate([], quietOrBusy(run(25, 25), run(27, 27)), loadedAt(10, 10, 10));
    expect(result.code).toBe(0);
    expect(result.lines).toContain('with issues busy, against the quiet trials of this run:');
  });

  test('fails when chat regresses with issues busy, though the quiet trials held', async () => {
    const result = await gate([], quietOrBusy(run(25, 25), run(250, 250)), loadedAt(10, 10, 10));
    expect(result.code).toBe(1);
  });

  test('fails when the quiet trials regress against the baseline, whatever issues does', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    await Bun.write(file, JSON.stringify(run(30, 30)));
    const result = await gate(
      ['--baseline', file],
      quietOrBusy(run(100, 30), run(100, 30)),
      loadedAt(10, 10, 10),
    );
    expect(result.code).toBe(1);
  });
});

describe('every module’s hot path, with the others busy (D-250 rule 6)', () => {
  /** A module's hot path answered at these p95s in turn, and what it was asked. */
  const loading = (
    ...answers: readonly number[]
  ): { readonly measure: LoadedMeasure; readonly asked: { subject: string; count: number }[] } => {
    const asked: { subject: string; count: number }[] = [];
    return {
      asked,
      measure: (subject, count): ReturnType<LoadedMeasure> => {
        asked.push({ subject, count });
        return Promise.resolve({
          p95: { list: answers[asked.length - 1] ?? 999 },
          busy: { chat: BUSY },
        });
      },
    };
  };
  const baselineWith = async (listP95Ms: number | null): Promise<string> => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const loaded =
      listP95Ms === null ? {} : { loaded: { 'issues/list': { p95Ms: listP95Ms, trials: [] } } };
    await Bun.write(file, JSON.stringify({ ...run(30, 30), ...loaded }));
    return file;
  };

  test('is measured in three trials of sixty reads, and the lowest is kept with every trial', async () => {
    const file = join(tmpdir(), `latency-${crypto.randomUUID()}.json`);
    const { measure, asked } = loading(18, 11, 14);
    const result = await main(['--keep', file], () => Promise.resolve(run(30, 30)), measure);
    expect(asked).toEqual(Array.from({ length: 3 }, () => ({ subject: 'issues', count: 60 })));
    expect(result.code).toBe(0);
    expect(await Bun.file(file).json()).toMatchObject({
      loaded: { 'issues/list': { p95Ms: 11, trials: [18, 11, 14] } },
    });
    expect(result.lines.join('\n')).toContain('issues/list with the others busy p95: 11.0 ms');
    expect(result.lines).toContain('issues trial 2/3: chat answered 100, refused 3');
  });

  test('passes against its own recorded number with the noise of D-267: a stalled trial is not a regression', async () => {
    const file = await baselineWith(10);
    const { measure, asked } = loading(90, 12, 13);
    expect((await main(['--keep', file], () => Promise.resolve(run(30, 30)), measure)).code).toBe(
      0,
    );
    expect(asked).toHaveLength(3);
  });

  test('fails when every trial is past the limit, measured again once, and keeps nothing', async () => {
    const file = await baselineWith(10);
    const original = await Bun.file(file).text();
    const { measure, asked } = loading(...Array.from({ length: 6 }, () => 40));
    const result = await main(['--keep', file], () => Promise.resolve(run(30, 30)), measure);
    expect(result.code).toBe(1);
    expect(asked).toHaveLength(6);
    expect(result.lines.join('\n')).toContain(
      'issues/list with the others busy p95: 40.0 ms (60 reads, was 10.0 ms, limit 20.0 ms) — REGRESSED',
    );
    expect(await Bun.file(file).text()).toBe(original);
  });

  test('the limit is the rule of D-267: the factor, the spread of the floor and the noise floor', async () => {
    for (const [before, now, regressed] of [
      [10, 20, false],
      [10, 20.1, true],
      [40, 60, false],
      [40, 60.1, true],
    ] as const) {
      const file = await baselineWith(before);
      const { measure } = loading(...Array.from({ length: 6 }, () => now));
      const result = await main(['--keep', file], () => Promise.resolve(run(30, 30)), measure);
      expect(result.code).toBe(regressed ? 1 : 0);
    }
  });

  test('a baseline from before it was measured is not compared, and the run is recorded', async () => {
    const file = await baselineWith(null);
    const { measure } = loading(500, 500, 500);
    const result = await main(['--keep', file], () => Promise.resolve(run(30, 30)), measure);
    expect(result.code).toBe(0);
    expect(await Bun.file(file).json()).toMatchObject({
      loaded: { 'issues/list': { p95Ms: 500 } },
    });
  });

  test('a measurement that is not a finite positive number is an error', async () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const refusal = await main([], () => Promise.resolve(run(30, 30)), loadedAt(value)).then(
        () => 'accepted',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(refusal).toContain('finite');
    }
  });

  test('the gate asks for the hot path of every module that declares one and is judged on the baseline', async () => {
    const asked: string[] = [];
    await gate(
      [],
      (_count, issuesBusy) =>
        Promise.resolve(
          issuesBusy ? { ...run(25, 25), issues: { answered: 1, refused: 0 } } : run(25, 25),
        ),
      (subject) => {
        asked.push(subject);
        return Promise.resolve({ p95: { list: 10 }, busy: { chat: BUSY } });
      },
    );
    const declared = Object.entries(HOT_PATHS).flatMap(([id, path]) =>
      'judged' in path && path.judged === 'baseline' ? [id] : [],
    );
    expect(declared).toEqual(['issues']);
    expect([...new Set(asked)]).toEqual(declared);
  });
});

/**
 * The modules that declare no hot path, with why. A third module is either measured while the others are busy or is
 * a line here that a reviewer reads (D-250 rule 6): it cannot skip the gate by saying nothing.
 */
const WITHOUT_A_HOT_PATH: Readonly<Record<string, string>> = {};

describe('the table of hot paths', () => {
  test('has exactly the bundled modules, and a module without a hot path is listed here with its reason', () => {
    expect(Object.keys(HOT_PATHS).sort()).toEqual(
      bundledModules.map(({ manifest }) => manifest.id).sort(),
    );
    const declared = Object.fromEntries(
      Object.entries(HOT_PATHS).flatMap(([id, path]) => ('none' in path ? [[id, path.none]] : [])),
    );
    expect(declared).toEqual(WITHOUT_A_HOT_PATH);
    for (const reason of Object.values(WITHOUT_A_HOT_PATH)) expect(reason.trim()).not.toBe('');
  });
});
