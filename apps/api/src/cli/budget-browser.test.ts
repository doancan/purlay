/** The browser budgets' gate: what the browser tests measured, judged against main's last (D-49). */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HISTORY_LENGTH, historyOf, judge, main, measured } from './budget-browser';

const folderWith = (files: Record<string, unknown>): string => {
  const folder = mkdtempSync(join(tmpdir(), 'purlay-budget-browser-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), JSON.stringify(content));
  }
  return folder;
};

const wide = (project: string): Record<string, unknown> => ({
  [`cold-load-${project}.json`]: { elapsed: 400 },
  [`keystroke-to-paint-${project}.json`]: { toDocument: { p50: 6 }, toNextFrame: { p50: 18 } },
  [`channel-switch-${project}.json`]: { p50: 140, all: [] },
});

describe('what the browser tests measured', () => {
  test('is read by name from each file the project wrote', async () => {
    expect(await measured(folderWith(wide('chromium-dark')), 'chromium-dark')).toEqual({
      'cold load, median of five': 400,
      'keystroke to the document, median': 6,
      'keystroke to the next frame, median': 18,
      'channel switch, median': 140,
    });
  });

  test("leaves out what the project did not measure, and another project's numbers", async () => {
    const folder = folderWith({
      ...wide('chromium-dark'),
      'cold-load-chromium-dark-narrow.json': { elapsed: 500 },
    });
    expect(await measured(folder, 'chromium-dark-narrow')).toEqual({
      'cold load, median of five': 500,
    });
  });

  test('refuses a file that is not the measurement it is named for', async () => {
    const folder = folderWith({ 'cold-load-chromium-dark.json': { took: 400 } });
    let refused: unknown;
    try {
      await measured(folder, 'chromium-dark');
    } catch (error) {
      refused = error;
    }
    expect(String(refused)).toContain('cold-load-chromium-dark.json');
  });
});

describe('the judgement', () => {
  test('without a baseline reports every number and passes', () => {
    const verdict = judge({ 'channel switch, median': 140 }, null);
    expect(verdict.regressed).toBe(false);
    expect(verdict.lines).toEqual(['channel switch, median: 140.0 ms']);
  });

  test('fails a jump past the factor and the floor, and says which', () => {
    const run = { 'channel switch, median': 140, 'cold load, median of five': 400 };
    const verdict = judge({ 'channel switch, median': 220, 'cold load, median of five': 410 }, [
      run,
      run,
      run,
    ]);
    expect(verdict.regressed).toBe(true);
    expect(verdict.lines).toEqual([
      'cold load, median of five: 410.0 ms, was 400.0 ms',
      'channel switch, median: 220.0 ms, was 140.0 ms — REGRESSED',
    ]);
  });

  test('is judged against the slowest of the runs, so a lucky run is not the line and a slow one is not a regression', () => {
    // Identical code measured 58, 72 and 124 ms on the same kind of runner (D-49, amended).
    const history = [107, 95, 124, 99, 58].map((value) => ({ 'channel switch, median': value }));
    const slow = judge({ 'channel switch, median': 150 }, history);
    expect(slow.regressed).toBe(false);
    expect(slow.lines).toEqual(['channel switch, median: 150.0 ms, was 124.0 ms']);
    expect(judge({ 'channel switch, median': 190 }, history).regressed).toBe(true);
  });

  test('is wider while there are fewer than three runs to see the spread of', () => {
    const one = [{ 'channel switch, median': 76 }];
    expect(judge({ 'channel switch, median': 124 }, one).regressed).toBe(false);
    expect(judge({ 'channel switch, median': 160 }, one).regressed).toBe(true);
    const three = [76, 76, 76].map((value) => ({ 'channel switch, median': value }));
    expect(judge({ 'channel switch, median': 124 }, three).regressed).toBe(true);
  });

  test('fails a number main measured and this run did not', () => {
    const verdict = judge({ 'cold load, median of five': 400 }, [
      { 'cold load, median of five': 400, 'channel switch, median': 140 },
    ]);
    expect(verdict.regressed).toBe(true);
    expect(verdict.lines).toContain('channel switch, median: not measured, was 140.0 ms — MISSING');
  });
});

describe('the kept file', () => {
  test('is a history, and what it was before — one run, flat — is a history of one', () => {
    expect(historyOf({ history: [{ a: 1 }, { a: 2 }] })).toEqual([{ a: 1 }, { a: 2 }]);
    expect(historyOf({ 'channel switch, median': 76 })).toEqual([{ 'channel switch, median': 76 }]);
    expect(historyOf(null)).toEqual([]);
    expect(historyOf('nonsense')).toEqual([]);
  });
});

describe('the command', () => {
  test('refuses to run without a project', async () => {
    expect((await main([])).code).toBe(1);
  });

  test('refuses a run that measured nothing, rather than passing it', async () => {
    const result = await main(['--project', 'chromium-dark', '--from', folderWith({})]);
    expect(result.code).toBe(1);
    expect(result.lines.join('\n')).toContain('nothing was measured');
  });

  test('keeps the first run as the baseline, then holds the next to it', async () => {
    const keep = join(mkdtempSync(join(tmpdir(), 'purlay-budget-keep-')), 'browser.json');
    const first = await main([
      '--project',
      'chromium-dark',
      '--from',
      folderWith(wide('chromium-dark')),
      '--keep',
      keep,
    ]);
    expect(first.code).toBe(0);
    expect(first.lines[0]).toBe('no baseline yet: this run is recorded, nothing compared');

    const slower = { ...wide('chromium-dark'), 'channel-switch-chromium-dark.json': { p50: 300 } };
    const second = await main([
      '--project',
      'chromium-dark',
      '--from',
      folderWith(slower),
      '--keep',
      keep,
    ]);
    expect(second.code).toBe(1);
    // A regression is not adopted: the history is still the run that passed.
    const kept = JSON.parse(await Bun.file(keep).text()) as { history: Record<string, number>[] };
    expect(kept.history).toHaveLength(1);
    expect(kept.history[0]).toMatchObject({ 'channel switch, median': 140 });
  });

  test('keeps the last few runs that passed, and no more', async () => {
    const keep = join(mkdtempSync(join(tmpdir(), 'purlay-budget-keep-')), 'browser.json');
    for (let run = 0; run < HISTORY_LENGTH + 3; run += 1) {
      const files = {
        ...wide('chromium-dark'),
        'channel-switch-chromium-dark.json': { p50: 140 + run },
      };
      const result = await main([
        '--project',
        'chromium-dark',
        '--from',
        folderWith(files),
        '--keep',
        keep,
      ]);
      expect(result.code).toBe(0);
    }
    const kept = JSON.parse(await Bun.file(keep).text()) as { history: Record<string, number>[] };
    expect(kept.history).toHaveLength(HISTORY_LENGTH);
    expect(kept.history.at(-1)).toMatchObject({
      'channel switch, median': 140 + HISTORY_LENGTH + 2,
    });
  });
});

describe('a regression, measured again alone (D-227)', () => {
  const keptWith = async (channelSwitch: number): Promise<string> => {
    const keep = join(mkdtempSync(join(tmpdir(), 'purlay-budget-keep-')), 'browser.json');
    const run = {
      'cold load, median of five': 400,
      'keystroke to the document, median': 6,
      'keystroke to the next frame, median': 18,
      'channel switch, median': channelSwitch,
    };
    await Bun.write(keep, JSON.stringify({ history: [run, run, run] }));
    return keep;
  };
  const slowerBy = (p50: number): Record<string, unknown> => ({
    ...wide('chromium-dark'),
    'channel-switch-chromium-dark.json': { p50 },
  });
  /** What the browser tests write when they are run again: these files, into the folder read. */
  const measuringAgain =
    (folder: string, files: Record<string, unknown> | null, code = 0) =>
    (project: string): Promise<number> => {
      expect(project).toBe('chromium-dark');
      for (const [name, content] of Object.entries(files ?? {})) {
        writeFileSync(join(folder, name), JSON.stringify(content));
      }
      return Promise.resolve(code);
    };
  const historyIn = async (keep: string): Promise<Record<string, number>[]> =>
    (JSON.parse(await Bun.file(keep).text()) as { history: Record<string, number>[] }).history;

  test('passes when the measurement taken again holds, and keeps that one rather than the first', async () => {
    const keep = await keptWith(140);
    const folder = folderWith(slowerBy(300));
    const result = await main(
      ['--project', 'chromium-dark', '--from', folder, '--keep', keep, '--remeasure'],
      measuringAgain(folder, slowerBy(150)),
    );
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      'cold load, median of five: 400.0 ms, was 400.0 ms',
      'keystroke to the document, median: 6.0 ms, was 6.0 ms',
      'keystroke to the next frame, median: 18.0 ms, was 18.0 ms',
      'channel switch, median: 300.0 ms, was 140.0 ms — REGRESSED',
      'first measurement regressed; measured again alone:',
      'cold load, median of five: 400.0 ms, was 400.0 ms',
      'keystroke to the document, median: 6.0 ms, was 6.0 ms',
      'keystroke to the next frame, median: 18.0 ms, was 18.0 ms',
      'channel switch, median: 150.0 ms, was 140.0 ms',
    ]);
    const history = await historyIn(keep);
    expect(history).toHaveLength(4);
    expect(history.at(-1)).toMatchObject({ 'channel switch, median': 150 });
  });

  test('fails a regression that repeats, and keeps nothing', async () => {
    const keep = await keptWith(140);
    const before = await Bun.file(keep).text();
    const folder = folderWith(slowerBy(300));
    const result = await main(
      ['--project', 'chromium-dark', '--from', folder, '--keep', keep, '--remeasure'],
      measuringAgain(folder, slowerBy(290)),
    );
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toBe('channel switch, median: 290.0 ms, was 140.0 ms — REGRESSED');
    expect(await Bun.file(keep).text()).toBe(before);
  });

  test('fails when measuring again fails, rather than passing on the measurement it did not take', async () => {
    const keep = await keptWith(140);
    const before = await Bun.file(keep).text();
    const folder = folderWith(slowerBy(300));
    const result = await main(
      ['--project', 'chromium-dark', '--from', folder, '--keep', keep, '--remeasure'],
      measuringAgain(folder, slowerBy(150), 1),
    );
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toContain('measuring again failed (exit 1)');
    expect(await Bun.file(keep).text()).toBe(before);
  });

  test('fails when measuring again wrote nothing, and does not read the first measurement twice', async () => {
    const keep = await keptWith(140);
    const folder = folderWith(slowerBy(300));
    const result = await main(
      ['--project', 'chromium-dark', '--from', folder, '--keep', keep, '--remeasure'],
      measuringAgain(folder, null),
    );
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toContain('nothing was measured again');
  });

  test('fails a number that measuring again did not take, as the first judgement would', async () => {
    const keep = await keptWith(140);
    const folder = folderWith(slowerBy(300));
    const withoutTheSwitch = Object.fromEntries(
      Object.entries(slowerBy(150)).filter(([name]) => !name.startsWith('channel-switch')),
    );
    const result = await main(
      ['--project', 'chromium-dark', '--from', folder, '--keep', keep, '--remeasure'],
      measuringAgain(folder, withoutTheSwitch),
    );
    expect(result.code).toBe(1);
    expect(result.lines.at(-1)).toBe(
      'channel switch, median: not measured, was 140.0 ms — MISSING',
    );
  });

  test('without --remeasure fails on the first regression, as before, and measures nothing again', async () => {
    const keep = await keptWith(140);
    const folder = folderWith(slowerBy(300));
    let measuredAgain = false;
    const result = await main(
      ['--project', 'chromium-dark', '--from', folder, '--keep', keep],
      () => {
        measuredAgain = true;
        return Promise.resolve(0);
      },
    );
    expect(result.code).toBe(1);
    expect(measuredAgain).toBe(false);
    expect(result.lines.at(-1)).toBe('channel switch, median: 300.0 ms, was 140.0 ms — REGRESSED');
  });

  test('does not measure again a run that passed', async () => {
    const keep = await keptWith(140);
    let measuredAgain = false;
    const result = await main(
      [
        '--project',
        'chromium-dark',
        '--from',
        folderWith(slowerBy(150)),
        '--keep',
        keep,
        '--remeasure',
      ],
      () => {
        measuredAgain = true;
        return Promise.resolve(0);
      },
    );
    expect(result.code).toBe(0);
    expect(measuredAgain).toBe(false);
  });
});

test('malformed JSON and missing nested measurements are refused', async () => {
  const folder = folderWith({ 'keystroke-to-paint-chromium-dark.json': { toDocument: null } });
  const missing = await measured(folder, 'chromium-dark').then(
    () => null,
    (error: unknown) => error,
  );
  expect(missing).toBeInstanceOf(Error);
  writeFileSync(join(folder, 'keystroke-to-paint-chromium-dark.json'), '{broken');
  const malformed = await measured(folder, 'chromium-dark').then(
    () => null,
    (error: unknown) => error,
  );
  expect(malformed).toBeInstanceOf(SyntaxError);
});
