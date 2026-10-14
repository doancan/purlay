/**
 * When the scheduler runs what (D-30, #72): each job at its own minute of the hour or the day, in
 * UTC, and a loop that sleeps until the next one is due, runs it, and stops when it is told to.
 */
import { describe, expect, test } from 'bun:test';
import { PLAN, nextRun, runSchedule, type Slot } from './schedule';

const at = (iso: string): Date => new Date(iso);

describe('the next run of a slot', () => {
  const hourly: Slot = { job: 'sweep:sessions', every: 'hour', minute: 15 };
  const daily: Slot = { job: 'sweep:orphans', every: 'day', hour: 3, minute: 0 };

  test('hourly: this hour’s minute if it is still ahead, else the next hour’s', () => {
    expect(nextRun(hourly, at('2026-09-09T12:00:00.000Z'))).toEqual(at('2026-09-09T12:15:00.000Z'));
    expect(nextRun(hourly, at('2026-09-09T12:15:00.000Z'))).toEqual(at('2026-09-09T13:15:00.000Z'));
    expect(nextRun(hourly, at('2026-09-09T23:30:00.000Z'))).toEqual(at('2026-09-10T00:15:00.000Z'));
  });

  test('daily: today’s time if it is still ahead, else tomorrow’s, across a month', () => {
    expect(nextRun(daily, at('2026-09-09T02:59:59.000Z'))).toEqual(at('2026-09-09T03:00:00.000Z'));
    expect(nextRun(daily, at('2026-09-09T03:00:00.000Z'))).toEqual(at('2026-09-10T03:00:00.000Z'));
    expect(nextRun(daily, at('2026-09-30T12:00:00.000Z'))).toEqual(at('2026-10-01T03:00:00.000Z'));
  });

  test('the deployment’s plan names every job the runner knows, each once', () => {
    expect(PLAN.map((slot) => slot.job).sort()).toEqual([
      'purge:retention',
      'reconcile:storage',
      'sweep:email-sign-ins',
      'sweep:exports',
      'sweep:github-deliveries',
      'sweep:link-previews',
      'sweep:orphans',
      'sweep:sessions',
    ]);
  });
});

describe('the loop', () => {
  test('first runs what has never succeeded, at once, so a new deployment is proven on day one', async () => {
    const ran: string[] = [];
    const said: string[] = [];
    let stop = false;
    await runSchedule({
      plan: PLAN,
      clock: { now: () => at('2026-09-09T02:50:00.000Z') },
      sleep: () => Promise.resolve(),
      run: (job) => {
        ran.push(job);
        stop = true;
        return Promise.resolve(1);
      },
      stopped: () => stop,
      log: { info: (msg) => said.push(msg), error: (msg) => said.push(msg) },
    });
    expect(ran).toEqual(['jobs:first']);
    expect(said).toEqual(['a scheduled job exited with a failure']);
  });

  test('told to stop before it began, it runs nothing', async () => {
    const ran: string[] = [];
    await runSchedule({
      plan: PLAN,
      clock: { now: () => at('2026-09-09T02:50:00.000Z') },
      sleep: () => Promise.resolve(),
      run: (job) => {
        ran.push(job);
        return Promise.resolve(0);
      },
      stopped: () => true,
      log: { info: () => undefined, error: () => undefined },
    });
    expect(ran).toEqual([]);
  });

  test('sleeps to each run in turn, runs it, says how it ended, and stops when told', async () => {
    let now = at('2026-09-09T02:50:00.000Z');
    const ran: string[] = [];
    const said: { msg: string; fields: Record<string, unknown> }[] = [];
    let stop = false;
    await runSchedule({
      plan: PLAN,
      clock: { now: () => now },
      sleep: (ms) => {
        now = new Date(now.getTime() + ms);
        return Promise.resolve();
      },
      run: (job) => {
        ran.push(`${now.toISOString()} ${job}`);
        if (ran.length === 5) stop = true;
        return Promise.resolve(job === 'reconcile:storage' ? 1 : 0);
      },
      stopped: () => stop,
      log: {
        info: (msg, fields = {}) => said.push({ msg, fields }),
        error: (msg, fields = {}) => said.push({ msg, fields }),
      },
    });
    expect(ran).toEqual([
      '2026-09-09T02:50:00.000Z jobs:first',
      '2026-09-09T03:00:00.000Z sweep:orphans',
      '2026-09-09T03:15:00.000Z sweep:sessions',
      '2026-09-09T03:30:00.000Z reconcile:storage',
      '2026-09-09T03:40:00.000Z sweep:exports',
    ]);
    expect(said.find((s) => s.fields['job'] === 'reconcile:storage')).toMatchObject({
      msg: 'a scheduled job exited with a failure',
      fields: { exitCode: 1 },
    });
  });
});
