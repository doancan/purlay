/** The browser budgets' gate: what the browser tests measured, judged against main's last (D-49). */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judge, main, measured } from './budget-browser';

const folderWith = (files: Record<string, unknown>): string => {
  const folder = mkdtempSync(join(tmpdir(), 'purlay-budget-browser-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(folder, name), JSON.stringify(content));
  }
  return folder;
};

const wide = (project: string): Record<string, unknown> => ({
  [`cold-load-${project}.json`]: { elapsed: 400 },
  [`keystroke-to-paint-${project}.json`]: { toDocument: { p95: 6 }, toNextFrame: { p95: 18 } },
  [`channel-switch-${project}.json`]: { p95: 140, all: [] },
});

describe('what the browser tests measured', () => {
  test('is read by name from each file the project wrote', async () => {
    expect(await measured(folderWith(wide('chromium-dark')), 'chromium-dark')).toEqual({
      'cold load': 400,
      'keystroke to the document p95': 6,
      'keystroke to the next frame p95': 18,
      'channel switch p95': 140,
    });
  });

  test("leaves out what the project did not measure, and another project's numbers", async () => {
    const folder = folderWith({
      ...wide('chromium-dark'),
      'cold-load-chromium-dark-narrow.json': { elapsed: 500 },
    });
    expect(await measured(folder, 'chromium-dark-narrow')).toEqual({ 'cold load': 500 });
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
    const verdict = judge({ 'channel switch p95': 140 }, null);
    expect(verdict.regressed).toBe(false);
    expect(verdict.lines).toEqual(['channel switch p95: 140.0 ms']);
  });

  test('fails a jump past the factor and the floor, and says which', () => {
    const verdict = judge(
      { 'channel switch p95': 220, 'cold load': 410 },
      {
        'channel switch p95': 140,
        'cold load': 400,
      },
    );
    expect(verdict.regressed).toBe(true);
    expect(verdict.lines).toEqual([
      'cold load: 410.0 ms, was 400.0 ms',
      'channel switch p95: 220.0 ms, was 140.0 ms — REGRESSED',
    ]);
  });

  test('fails a number main measured and this run did not', () => {
    const verdict = judge({ 'cold load': 400 }, { 'cold load': 400, 'channel switch p95': 140 });
    expect(verdict.regressed).toBe(true);
    expect(verdict.lines).toContain('channel switch p95: not measured, was 140.0 ms — MISSING');
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

    const slower = { ...wide('chromium-dark'), 'channel-switch-chromium-dark.json': { p95: 300 } };
    const second = await main([
      '--project',
      'chromium-dark',
      '--from',
      folderWith(slower),
      '--keep',
      keep,
    ]);
    expect(second.code).toBe(1);
    // A regression is not adopted: the baseline is still the run that passed.
    expect(JSON.parse(await Bun.file(keep).text())).toMatchObject({ 'channel switch p95': 140 });
  });
});
