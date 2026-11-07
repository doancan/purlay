import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { bundledModules } from '../composition';
import { moduleCells } from './module-cells';
import {
  cellsToRun,
  integrationSuites,
  leftOutLines,
  main,
  partition,
  SUITE_ROOTS,
  type Say,
} from './module-suites';
import { matrixSettings } from './module-cells-matrix';
import { needsReader } from './module-needs';

const CARRIED = bundledModules.map((module) => module.manifest.id);

/** What a suite needs, as a table: the suites of a test are names. */
const needing =
  (table: Readonly<Record<string, readonly string[]>>) =>
  (file: string): readonly string[] =>
    table[file] ?? [];

describe('which suites a cell runs', () => {
  const needsOf = needing({
    plain: [],
    chatty: ['chat'],
    tracker: ['issues'],
    both: ['chat', 'issues'],
  });
  const suites = ['plain', 'chatty', 'tracker', 'both'];

  test('the ones that need nothing of a module it lacks, and the rest are left out with what each lacks', () => {
    expect(partition(suites, needsOf, [])).toEqual({
      runs: ['plain'],
      left: [
        { file: 'chatty', missing: ['chat'] },
        { file: 'tracker', missing: ['issues'] },
        { file: 'both', missing: ['chat', 'issues'] },
      ],
    });
    expect(partition(suites, needsOf, ['chat']).runs).toEqual(['plain', 'chatty']);
    expect(partition(suites, needsOf, ['issues', 'chat']).left).toEqual([]);
  });

  test('is said by what was left out, grouped by what it needs', () => {
    const { left } = partition(suites, needsOf, []);
    expect(leftOutLines(left)).toEqual([
      '1 suites need chat, which this cell does not run',
      '1 suites need issues, which this cell does not run',
      '1 suites need chat + issues, which this cell does not run',
    ]);
  });

  test('every cell but the one that runs every module, which is the whole suite’s own run', () => {
    const cells = cellsToRun(CARRIED, moduleCells(bundledModules));
    expect(cells).toHaveLength(2 ** CARRIED.length - 1);
    expect(cells.map((cell) => cell.ids.length).every((count) => count < CARRIED.length)).toBe(
      true,
    );
    expect(cells[0]?.setting).toBe('none');
  });
});

describe('the suites of the repository', () => {
  const suites = integrationSuites();

  test('are the integration files of the API and of the database package', () => {
    expect(SUITE_ROOTS).toHaveLength(2);
    expect(suites.length).toBeGreaterThan(100);
    expect(suites.every((file) => file.endsWith('.integration.test.ts'))).toBe(true);
    expect(suites.some((file) => file.includes('/packages/db/'))).toBe(true);
    expect(suites.some((file) => file.includes('/apps/api/'))).toBe(true);
  });

  test('need only modules this build carries: a misspelt id in a declaration would leave a suite out of every cell', () => {
    const needsOf = needsReader(CARRIED);
    const unknown = suites.flatMap((file) =>
      needsOf(file)
        .filter((id) => !CARRIED.includes(id))
        .map((id) => `${file} needs ${id}`),
    );
    expect(unknown).toEqual([]);
  });

  test('leave a suite that needs no module in every cell, so that the cells prove something', () => {
    const needsOf = needsReader(CARRIED);
    const independent = suites.filter((file) => needsOf(file).length === 0);
    expect(independent.length).toBeGreaterThan(20);
    for (const cell of cellsToRun(CARRIED, moduleCells(bundledModules))) {
      const { runs } = partition(suites, needsOf, cell.ids);
      for (const file of independent) expect(runs).toContain(file);
    }
  });
});

describe('the command', () => {
  const recorded = (): { say: Say; out: string[]; err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return { say: { out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
  };

  test('long source names yield separate bounded databases for every selected cell', async () => {
    for (const root of ['purlay_'.padEnd(63, 'x'), 'ğ'.repeat(31) + 'a']) {
      const databases: string[] = [];
      const { say } = recorded();
      expect(
        await main(
          { DATABASE_URL: `postgres://nobody@127.0.0.1:1/${encodeURIComponent(root)}` },
          say,
          (_cell, _suites, _base, database) => {
            databases.push(database);
            return Promise.resolve(0);
          },
        ),
      ).toBe(0);
      expect(new Set(databases).size).toBe(2 ** CARRIED.length - 1);
      for (const database of databases) {
        expect(Buffer.byteLength(database)).toBeLessThanOrEqual(63);
        expect(database === root).toBe(false);
      }
    }
  });

  test('runs each cell with the suites it keeps, and passes when every cell does', async () => {
    const { say, out } = recorded();
    const ran: string[] = [];
    const code = await main(
      { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
      say,
      (cell, suites, _base, database) => {
        ran.push(
          `${cell.setting ?? ''}:${String(suites.length)}:${String(database.endsWith(cell.setting ?? ''))}`,
        );
        return Promise.resolve(0);
      },
    );
    expect(code).toBe(0);
    expect(ran).toHaveLength(2 ** CARRIED.length - 1);
    expect(ran[0]?.startsWith('none:')).toBe(true);
    expect(out.filter((line) => line.startsWith('ok '))).toHaveLength(ran.length);
  });

  test('fails when one cell does, and still runs the others and says which', async () => {
    const { say, err } = recorded();
    let calls = 0;
    const code = await main({ DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, say, () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? 1 : 0);
    });
    expect(code).toBe(1);
    expect(calls).toBe(2 ** CARRIED.length - 1);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain('FAIL the core alone');
  });

  test('can be asked for the cells of a setting alone, for working on one', async () => {
    const { say } = recorded();
    const settings: (string | undefined)[] = [];
    await main(
      { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
      say,
      (cell) => {
        settings.push(cell.setting);
        return Promise.resolve(0);
      },
      ['none'],
    );
    expect(settings).toEqual(['none']);
  });

  test('refuses a setting no cell has, running nothing, as a pass for nothing would be a lie', async () => {
    const { say, err } = recorded();
    let calls = 0;
    const code = await main(
      { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' },
      say,
      () => {
        calls += 1;
        return Promise.resolve(0);
      },
      ['no-such-cell'],
    );
    expect({ code, calls }).toEqual({ code: 1, calls: 0 });
    expect(err[0]).toContain('no cell has MODULES no-such-cell');
  });

  test('refuses with no database, running nothing', async () => {
    const { say, err } = recorded();
    expect(await main({}, say, () => Promise.resolve(0))).toBe(1);
    expect(err[0]).toContain('DATABASE_URL is not set');
  });
});

describe('the workflow', () => {
  const workflow = Bun.YAML.parse(
    readFileSync(join(import.meta.dir, '../../../../.github/workflows/ci.yml'), 'utf8'),
  ) as {
    jobs: Record<
      string,
      {
        strategy?: { matrix?: { cell?: string } };
        steps?: { id?: string; run?: string }[];
      }
    >;
  };

  test('takes the legs of the suites-per-cell job from the build, so a new module cannot be left out of CI', () => {
    expect(workflow.jobs['module-suites']?.strategy?.matrix?.cell).toBe(
      '${{ fromJSON(needs.changes.outputs.cells) }}',
    );
    const step = workflow.jobs['changes']?.steps?.find((candidate) => candidate.id === 'cells');
    expect(step?.run).toContain('bun run modules:cells');
  });

  test('the command names a leg for each cell the build has but the one with every module', () => {
    const cells = cellsToRun(CARRIED, moduleCells(bundledModules)).map((cell) => cell.setting);
    expect(matrixSettings()).toEqual(cells.flatMap((setting) => setting ?? []));
    expect(matrixSettings()).toContain('none');
  });
});
