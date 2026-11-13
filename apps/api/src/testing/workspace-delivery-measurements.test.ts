import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { bundledModules } from '../composition';
import { moduleCells } from './module-cells';
import { needsReader } from './module-needs';
import {
  cohortMode,
  cohortReceiptPath,
  main,
  measure,
  measurementCells,
  receiptP95,
} from './workspace-delivery-measurements';

const identity = { runId: 'this-run', modules: 'chat', company: true };
interface Receipt {
  complete: boolean;
  measurement: typeof identity & { mode: string };
  nativeSources: number[];
  factualSelects: number[];
  fanout: { sources: number; sent: number; receipts: number; receiptP95Ms: number };
  productFanoutBudgetMs: number;
}
const rejected = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
};
const receipt = (given = identity): Receipt => ({
  complete: true,
  measurement: { ...given, mode: 'measure' },
  nativeSources: [12, 120],
  factualSelects: [7, 14],
  fanout: { sources: 120, sent: 120, receipts: 120, receiptP95Ms: 199.99 },
  productFanoutBudgetMs: 200,
});

describe('the native cohort measurement', () => {
  test('direct runs are strict; only explicit functional and measurement modes are accepted', () => {
    expect(cohortMode({})).toBe('strict');
    expect(cohortMode({ PURLAY_WORKSPACE_COHORT: 'functional' })).toBe('functional');
    expect(cohortMode({ PURLAY_WORKSPACE_COHORT: 'measure' })).toBe('measure');
    for (const mode of ['', 'skip', 'only', 'strict', 'typo'])
      expect(() => cohortMode({ PURLAY_WORKSPACE_COHORT: mode })).toThrow(
        'must be functional or measure',
      );
  });

  test('measurement inputs require the runner identity and explicit absolute JSON receipt', () => {
    const environment = {
      PURLAY_WORKSPACE_COHORT: 'measure',
      PURLAY_WORKSPACE_COHORT_RUN: '12345678-1234-4234-8234-123456789abc',
      PURLAY_WORKSPACE_COHORT_RECEIPT: '/owned/new-case.json',
    };
    expect(cohortReceiptPath(environment, '/ordinary')).toBe('/owned/new-case.json');
    expect(cohortReceiptPath({}, '/ordinary')).toBe('/ordinary');
    expect(cohortReceiptPath({ PURLAY_WORKSPACE_COHORT: 'functional' }, '/ordinary')).toBe(
      '/ordinary',
    );
    for (const over of [
      { PURLAY_WORKSPACE_COHORT_RUN: '' },
      { PURLAY_WORKSPACE_COHORT_RUN: 'earlier-run' },
      { PURLAY_WORKSPACE_COHORT_RECEIPT: '' },
      { PURLAY_WORKSPACE_COHORT_RECEIPT: 'relative.json' },
      { PURLAY_WORKSPACE_COHORT_RECEIPT: '/owned/not-json' },
    ])
      expect(() => cohortReceiptPath({ ...environment, ...over }, '/ordinary')).toThrow();
  });

  test('derives every eligible cell from the exact suite and its needs, including all modules', () => {
    const suite = resolve(
      import.meta.dir,
      '../realtime/workspace-delivery-batch.integration.test.ts',
    );
    const needs = needsReader(bundledModules.map(({ manifest }) => manifest.id))(suite);
    expect(needs.length).toBeGreaterThan(0);
    const expected = moduleCells(bundledModules).filter((cell) =>
      needs.every((id) => cell.ids.includes(id)),
    );
    expect(measurementCells().map((cell) => cell.setting)).toEqual(
      expected.map((cell) => cell.setting),
    );
    expect(measurementCells().some((cell) => cell.setting === undefined)).toBe(true);
  });

  test('each complete matching receipt must hold the unchanged 200 ms line', () => {
    expect(receiptP95(receipt(), identity)).toBe(199.99);
    for (const p95 of [0, -1, NaN, Infinity, 200, 200.01, 212])
      expect(() =>
        receiptP95({ ...receipt(), fanout: { ...receipt().fanout, receiptP95Ms: p95 } }, identity),
      ).toThrow();
  });

  test('refuses stale identity, partial fixtures, missing deliveries and unbounded factual reads', () => {
    const good = receipt();
    const bad: unknown[] = [
      null,
      {},
      { ...good, complete: false },
      { ...good, measurement: { ...good.measurement, runId: 'earlier-run' } },
      { ...good, measurement: { ...good.measurement, company: false } },
      { ...good, measurement: { ...good.measurement, modules: 'all' } },
      { ...good, measurement: { ...good.measurement, mode: 'functional' } },
      { ...good, nativeSources: [12] },
      { ...good, nativeSources: [12, 119] },
      ...[
        [0, 0],
        [9, 18],
        [7, 13],
        [7.5, 15],
        [7, 14, 14],
      ].map((factualSelects) => ({ ...good, factualSelects })),
      ...['sources', 'sent', 'receipts'].map((field) => ({
        ...good,
        fanout: { ...good.fanout, [field]: 119 },
      })),
      { ...good, productFanoutBudgetMs: 201 },
    ];
    for (const candidate of bad) expect(() => receiptP95(candidate, identity)).toThrow();
  });

  test('runs both cases exactly once per eligible cell, sequentially, with fresh identities and receipts', async () => {
    const owned = await mkdtemp(join(tmpdir(), 'workspace-cohort-test-'));
    const seen: { modules: string; company: boolean; runId: string }[] = [];
    let active = 0;
    let maximum = 0;
    try {
      expect(
        await measure({}, join(owned, 'run'), async (_cell, given, path) => {
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          seen.push(given);
          await writeFile(path, JSON.stringify(receipt(given)));
          active--;
          return 0;
        }),
      ).toBe(0);
      expect(maximum).toBe(1);
      expect(seen.map(({ modules, company }) => ({ modules, company }))).toEqual(
        measurementCells().flatMap((cell) =>
          [false, true].map((company) => ({ modules: cell.setting ?? 'all', company })),
        ),
      );
      expect(new Set(seen.map(({ runId }) => runId)).size).toBe(seen.length);
      expect(JSON.parse(await readFile(join(owned, 'run/summary.json'), 'utf8'))).toHaveLength(
        seen.length,
      );
    } finally {
      await rm(owned, { recursive: true });
    }
  });

  test('zero tests, stale receipts and failed processes refuse the run without retrying a case', async () => {
    const owned = await mkdtemp(join(tmpdir(), 'workspace-cohort-refusal-'));
    try {
      for (const kind of ['missing', 'stale', 'failed', 'incomplete', 'slow']) {
        let cases = 0;
        expect(
          await measure({}, join(owned, kind), async (_cell, given, path) => {
            cases++;
            const value = receipt(given);
            if (kind === 'stale') value.measurement.runId = 'earlier-run';
            if (kind === 'incomplete') value.complete = false;
            if (kind === 'slow') value.fanout.receiptP95Ms = 212;
            if (kind !== 'missing') await writeFile(path, JSON.stringify(value));
            return kind === 'failed' ? 1 : 0;
          }),
        ).toBe(1);
        expect(cases).toBe(measurementCells().length * 2);
      }
      const borrowed = join(owned, 'borrowed.json');
      await writeFile(borrowed, 'keep');
      expect(await rejected(measure({}, owned, () => Promise.resolve(0)))).toBeInstanceOf(Error);
      expect(await readFile(borrowed, 'utf8')).toBe('keep');
    } finally {
      await rm(owned, { recursive: true });
    }
  });

  test('without a database the local command is explicit and CI refuses before running anything', async () => {
    let ran = false;
    const run = (): Promise<number> => {
      ran = true;
      return Promise.resolve(0);
    };
    expect(await main({}, run)).toEqual({
      line: 'budget:workspace-cohort — DATABASE_URL is not set: the workspace cohort was NOT measured.',
      code: 0,
    });
    expect((await main({ CI: 'true' }, run)).code).toBe(1);
    expect(
      (await main({ CI: 'true', DATABASE_URL: 'postgres://none@127.0.0.1:1/none' }, run)).code,
    ).toBe(1);
    expect(await rejected(main({ PURLAY_WORKSPACE_COHORT: 'typo' }, run))).toBeInstanceOf(Error);
    expect(ran).toBe(false);
  });
});

test('the required isolated job is mapped, records every result and is part of local verify', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job =
    /^ {2}cohort-measurements:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/m.exec(workflow)?.[1] ?? '';
  expect(job).toMatch(/^ {4}needs: changes$/m);
  expect(job).toMatch(/^ {4}if: needs\.changes\.outputs\.modules == 'true'$/m);
  expect(job).toContain('run: bun run budget:workspace-cohort');
  expect(job).toContain('path: .budget/workspace-cohort');
  expect(job).toContain('if-no-files-found: error');
  expect(job).toContain('retention-days: 7');
  expect(job).not.toContain('continue-on-error');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts['verify']).toContain('&& bun run budget:workspace-cohort &&');
});
