/**
 * The areas of a run by area put together, and every file held to the floor in the process of its own area (D-341).
 *
 * CI runs the suite as three areas (`PURLAY_TEST_AREA`, `scripts/test-all.ts`), each in one process on a runner of
 * its own, under a configuration with the floor at zero. Each writes lcov and a `summary.json` to
 * `coverage/area-<name>/`. This reads all three and does what one run did by itself, without adding any lcov
 * up (lcov from different processes cannot be: Bun's says how many functions a file has and how many ran, not which,
 * and what a process counts as found depends on what it ran):
 *
 * 1. **The areas ran every test file, each its own.** An area says how many files it ran (what `bun test` prints
 *    as "across N files"); that must be the number of test files on disk that belong to it, every test file on disk
 *    must belong to an area, and every area must have exited 0. A file dropped, run twice or owned by nobody is a
 *    failure that says so, not a suite that passed on less than it should.
 * 2. **Every file meets the floor `bunfig.toml` holds, in the process of the area that owns it**, per file as
 *    Bun does: lines and functions each against their own floor. A process also loads files of other areas
 *    (the web tests load `packages/markdown`), and those are left to their owner. A file that belongs to no
 *    area (a root file, a copy a test makes in a temporary directory) is judged in the process that loaded it.
 * 3. **No file escapes by being loaded only by another area's tests.** A source file that an area loaded and its
 *    owner did not has no tests of its own area at all, and would otherwise be judged nowhere.
 *
 *   bun run coverage:floor [directory]     in CI: after every area's artifact has been downloaded to `coverage/`
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AREAS,
  type Area,
  type Floor,
  areaOfTest,
  ownerOf,
  readFloor,
  testFilesOnDisk,
} from './test-area';

/** What one process's lcov says of one file. */
export interface Measured {
  readonly linesFound: number;
  readonly linesHit: number;
  readonly functionsFound: number;
  readonly functionsHit: number;
}

/** Every file one process's lcov covers. */
export const parseLcov = (text: string): Map<string, Measured> => {
  const files = new Map<string, Measured>();
  let path: string | undefined;
  let lines = new Map<number, number>();
  let found = 0;
  let hit = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      path = line.slice(3).trim();
      lines = new Map();
      found = 0;
      hit = 0;
    } else if (line.startsWith('DA:')) {
      const [number, count] = line.slice(3).split(',');
      lines.set(Number(number), Number(count));
    } else if (line.startsWith('FNF:')) {
      found = Number(line.slice(4));
    } else if (line.startsWith('FNH:')) {
      hit = Number(line.slice(4));
    } else if (line === 'end_of_record' && path !== undefined) {
      files.set(path, {
        linesFound: lines.size,
        linesHit: [...lines.values()].filter((count) => count > 0).length,
        functionsFound: found,
        functionsHit: hit,
      });
      path = undefined;
    }
  }
  return files;
};

/** A fraction of a total; nothing to cover is covered. */
const share = (hit: number, found: number): number => (found === 0 ? 1 : hit / found);

const percent = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

/** One file under the floor. */
export interface Shortfall {
  readonly path: string;
  readonly detail: string;
}

/** Why a file is under the floor, as Bun judges it: lines and functions each against their own floor; empty when it is not. */
export const shortfallOf = (path: string, file: Measured, floor: Floor): Shortfall[] => {
  const shortfalls: Shortfall[] = [];
  const lines = share(file.linesHit, file.linesFound);
  if (lines < floor.lines) {
    shortfalls.push({
      path,
      detail: `${percent(lines)} of lines (${String(file.linesHit)}/${String(file.linesFound)}), floor ${percent(floor.lines)}`,
    });
  }
  const functions = share(file.functionsHit, file.functionsFound);
  if (functions < floor.functions) {
    shortfalls.push({
      path,
      detail: `${percent(functions)} of functions (${String(file.functionsHit)}/${String(file.functionsFound)}), floor ${percent(floor.functions)}`,
    });
  }
  return shortfalls;
};

/** What one area's process was judged on. */
export interface Judged {
  readonly area: Area;
  readonly judged: number;
  readonly shortfalls: Shortfall[];
  readonly lowestLines: { readonly path: string; readonly share: number } | undefined;
  readonly lowestFunctions: { readonly path: string; readonly share: number } | undefined;
}

/**
 * The files of one area's process that it answers for: those it owns, and those that belong to nobody. The others
 * are another area's, judged in that area's process; they are handed back in `elsewhere` for the check that
 * their owner loaded them.
 */
export const judgeArea = (
  area: Area,
  files: ReadonlyMap<string, Measured>,
  floor: Floor,
): { judged: Judged; elsewhere: string[] } => {
  const shortfalls: Shortfall[] = [];
  const elsewhere: string[] = [];
  let judged = 0;
  let lowestLines: Judged['lowestLines'];
  let lowestFunctions: Judged['lowestFunctions'];
  for (const [path, file] of files) {
    const owner = ownerOf(path);
    if (owner !== undefined && owner !== area) {
      elsewhere.push(path);
      continue;
    }
    judged += 1;
    shortfalls.push(...shortfallOf(path, file, floor));
    const lines = share(file.linesHit, file.linesFound);
    const functions = share(file.functionsHit, file.functionsFound);
    if (lowestLines === undefined || lines < lowestLines.share)
      lowestLines = { path, share: lines };
    if (lowestFunctions === undefined || functions < lowestFunctions.share) {
      lowestFunctions = { path, share: functions };
    }
  }
  return { judged: { area, judged, shortfalls, lowestLines, lowestFunctions }, elsewhere };
};

/** What `test-all.ts` wrote beside an area's lcov. */
export interface Summary {
  readonly area: string;
  readonly tests: number;
  readonly files: number;
  readonly exitCode: number;
}

/** Every reason the areas are not the whole suite, each running exactly the files it owns; empty when they are. */
export const checkAreas = (
  summaries: ReadonlyMap<Area, Summary>,
  testFiles: readonly string[],
): string[] => {
  const reasons: string[] = [];
  const unowned = testFiles.filter((file) => areaOfTest(file) === undefined);
  if (unowned.length > 0) {
    reasons.push(
      `${String(unowned.length)} test files belong to no area, so no job runs them: ${unowned.slice(0, 3).join(', ')}${unowned.length > 3 ? ', …' : ''}`,
    );
  }
  for (const area of AREAS) {
    const owned = testFiles.filter((file) => areaOfTest(file) === area).length;
    const summary = summaries.get(area);
    if (summary === undefined) continue;
    if (summary.exitCode !== 0) {
      reasons.push(`the ${area} area ended with exit code ${String(summary.exitCode)}`);
    }
    if (summary.files !== owned) {
      reasons.push(
        `the ${area} area ran ${String(summary.files)} test files and owns ${String(owned)}: a file was dropped or run twice`,
      );
    }
  }
  return reasons;
};

/** Files an area loaded that its owner did not: judged nowhere, unless this says so. */
export const unjudged = (
  loaded: ReadonlyMap<Area, ReadonlySet<string>>,
  elsewhere: ReadonlyMap<Area, readonly string[]>,
): string[] => {
  const reasons: string[] = [];
  for (const [area, paths] of elsewhere) {
    for (const path of paths) {
      const owner = ownerOf(path);
      if (owner !== undefined && !(loaded.get(owner)?.has(path) ?? false)) {
        reasons.push(
          `${path}: loaded by the ${area} tests and not by the ${owner} tests that own it, so it is judged nowhere`,
        );
      }
    }
  }
  return reasons.sort();
};

/** Reads `directory/area-<name>/` for every area, and says what is wrong with it, or that it is whole and over the floor. */
export const main = (directory: string, root = '.'): number => {
  const problems: string[] = [];
  const summaries = new Map<Area, Summary>();
  const measured = new Map<Area, Map<string, Measured>>();
  for (const area of AREAS) {
    const summaryPath = join(directory, `area-${area}`, 'summary.json');
    const lcovPath = join(directory, `area-${area}`, 'lcov.info');
    if (!existsSync(summaryPath) || !existsSync(lcovPath)) {
      problems.push(
        `the ${area} area has no ${existsSync(summaryPath) ? 'lcov.info' : 'summary.json'} in ${directory}/area-${area}/`,
      );
      continue;
    }
    summaries.set(area, JSON.parse(readFileSync(summaryPath, 'utf8')) as Summary);
    measured.set(area, parseLcov(readFileSync(lcovPath, 'utf8')));
  }
  const testFiles = testFilesOnDisk(root);
  problems.push(...checkAreas(summaries, testFiles));

  const floor = readFloor(readFileSync(join(root, 'bunfig.toml'), 'utf8'));
  const results: Judged[] = [];
  const elsewhere = new Map<Area, readonly string[]>();
  const loaded = new Map<Area, ReadonlySet<string>>();
  for (const [area, files] of measured) {
    const result = judgeArea(area, files, floor);
    results.push(result.judged);
    elsewhere.set(area, result.elsewhere);
    loaded.set(area, new Set(files.keys()));
  }
  problems.push(...unjudged(loaded, elsewhere));

  for (const problem of problems) console.error(`coverage:floor — ${problem}`);
  for (const result of results) {
    for (const shortfall of result.shortfalls) {
      console.error(`coverage:floor — ${shortfall.path} (${result.area}): ${shortfall.detail}`);
    }
  }
  const failed = problems.length > 0 || results.some((result) => result.shortfalls.length > 0);
  for (const result of results) {
    const lines = result.lowestLines;
    const functions = result.lowestFunctions;
    console.log(
      `coverage:floor — ${result.area}: ${String(summaries.get(result.area)?.files ?? 0)} test files, ${String(result.judged)} source files judged; lowest ${lines === undefined ? 'none' : `${percent(lines.share)} of lines (${lines.path})`}, ${functions === undefined ? 'none' : `${percent(functions.share)} of functions (${functions.path})`}`,
    );
  }
  if (!failed) {
    console.log(
      `coverage:floor — every file at or over ${percent(floor.lines)} of lines and ${percent(floor.functions)} of functions in the process of its own area`,
    );
  }
  return failed ? 1 : 0;
};

if (import.meta.main) {
  const result = process.env['PURLAY_SCHEMA_AREA_RESULT'];
  if ((result !== undefined || process.env['CI'] === 'true') && result !== 'success') {
    console.error(
      `coverage:floor — schema-area ended ${result ?? 'without a result'}: the suite is not whole`,
    );
    process.exit(1);
  }
  process.exit(main(process.argv[2] ?? 'coverage'));
}
