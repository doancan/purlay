/**
 * The browser budgets on a shared runner (`PRD.md` §5, D-49): cold load, keystroke to paint and the
 * channel switch, each as the middle of its run, as the browser tests measured them (`apps/web/e2e/performance.e2e.ts` writes each
 * to `test-results/performance/<measure>-<project>.json`).
 *
 *   bun run budget:browser -- --project <name> [--from <folder>] [--keep <file>]
 *
 * **It blocks on a regression, never on the line**, by the same rule as `budget:latency`: on a hosted
 * runner the channel switch measured 120–170 ms where a laptop measures 33 ms, and moves by tens of
 * percent between identical runs. The line itself is held where it means something — the browser
 * tests assert it on a developer's machine. Here a number fails when it jumped past the slowest of main's last few runs (`historyOf`), and
 * a number main measured that this run did not is a failure too: a measurement that quietly stopped
 * is not a pass. A run that measured nothing at all is refused.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jumped, optionOf, REGRESSION_FACTOR } from './budget-latency';

/**
 * Each number: its name in the report, the file it is in, and where in that file. The middle of
 * each run, not its tail: a p95 of twenty is the second-worst of twenty, one stall on a shared
 * machine moves it by half, and a gate that fails on one stall is re-run until nobody reads it
 * (D-49). A real slowdown moves the median. The tests still hold the p95s to their lines.
 */
const MEASURES = [
  { name: 'cold load, median of five', file: 'cold-load', at: ['elapsed'] },
  {
    name: 'keystroke to the document, median',
    file: 'keystroke-to-paint',
    at: ['toDocument', 'p50'],
  },
  {
    name: 'keystroke to the next frame, median',
    file: 'keystroke-to-paint',
    at: ['toNextFrame', 'p50'],
  },
  { name: 'channel switch, median', file: 'channel-switch', at: ['p50'] },
  {
    name: 'channel switch back after 2000 messages were read, median',
    file: 'feed-scale',
    at: ['loaded-2000', 'switchBack', 'p50'],
  },
  {
    name: 'keystroke with 2000 messages loaded, median',
    file: 'feed-scale',
    at: ['loaded-2000', 'keystroke', 'p50'],
  },
] as const;

type Measured = Readonly<Record<string, number>>;

const FROM = 'apps/web/test-results/performance';

const dig = (value: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (inside, key) =>
      typeof inside === 'object' && inside !== null
        ? (inside as Record<string, unknown>)[key]
        : undefined,
    value,
  );

const readJson = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

/** What one project measured, by name; a measure it did not take is absent, not zero. */
export const measured = async (folder: string, project: string): Promise<Measured> => {
  const found: Record<string, number> = {};
  for (const measure of MEASURES) {
    const file = `${measure.file}-${project}.json`;
    const content = await readJson(join(folder, file));
    if (content === undefined) continue;
    const value = dig(content, measure.at);
    if (typeof value !== 'number') throw new Error(`${file} has no ${measure.at.join('.')}`);
    found[measure.name] = value;
  }
  return found;
};

/**
 * What a run is judged against: the last few runs that passed, oldest first. One run says what a runner
 * did that day, not what is normal — on a hosted runner the channel switch measured 58 ms in one run of
 * main and 107 in the next, identical — so a single lucky run kept as the baseline failed every change
 * after it (D-49, amended). The slowest of the history is the line: the same code measured 58, 72 and 124 ms on
 * one kind of runner, so the spread is the envelope and a regression is a jump out of it. While there are fewer
 * than `STEADY_FROM` runs to see a spread in, the factor is wider.
 */
export const HISTORY_LENGTH = 5;
const STEADY_FROM = 3;
const STEADY_FACTOR = REGRESSION_FACTOR;
const UNSTEADY_FACTOR = 2;

const slowest = (values: readonly number[]): number => Math.max(...values);

/** The kept file: `{ history: [...] }`, or what it was before — one run, flat — read as a history of one. */
export const historyOf = (kept: unknown): readonly Measured[] => {
  if (typeof kept !== 'object' || kept === null) return [];
  const found = (kept as { readonly history?: unknown }).history;
  return Array.isArray(found) ? (found as Measured[]) : [kept as Measured];
};

/** The lines to print, and whether the run regressed against the history, if there is one. */
export const judge = (
  now: Measured,
  history: readonly Measured[] | null,
): { readonly regressed: boolean; readonly lines: readonly string[] } => {
  let regressed = false;
  const lines: string[] = [];
  const newest = history?.at(-1);
  for (const { name } of MEASURES) {
    const value = now[name];
    const past = (history ?? []).flatMap((run) => (run[name] === undefined ? [] : [run[name]]));
    const before = past.length === 0 ? undefined : slowest(past);
    const was = before === undefined ? '' : `, was ${before.toFixed(1)} ms`;
    if (value === undefined) {
      if (newest?.[name] === undefined) continue;
      regressed = true;
      lines.push(`${name}: not measured${was} — MISSING`);
      continue;
    }
    const worse = jumped(
      value,
      before,
      past.length >= STEADY_FROM ? STEADY_FACTOR : UNSTEADY_FACTOR,
    );
    if (worse) regressed = true;
    lines.push(`${name}: ${value.toFixed(1)} ms${was}${worse ? ' — REGRESSED' : ''}`);
  }
  return { regressed, lines };
};

/** The command: read, judge against `--keep` if it exists, and keep the run only if it passed. */
export const main = async (
  args: readonly string[],
): Promise<{ readonly lines: readonly string[]; readonly code: number }> => {
  const project = optionOf(args, '--project');
  if (project === undefined) return { lines: ['budget:browser needs --project <name>'], code: 1 };
  const now = await measured(optionOf(args, '--from') ?? FROM, project);
  if (Object.keys(now).length === 0) {
    return { lines: [`budget:browser — nothing was measured for ${project}`], code: 1 };
  }
  const keepFile = optionOf(args, '--keep');
  const kept = keepFile === undefined ? undefined : await readJson(keepFile);
  const history = kept === undefined ? null : historyOf(kept);
  const { regressed, lines } = judge(now, history);
  // A regression is not adopted: the next run is judged against the runs that passed.
  if (keepFile !== undefined && !regressed) {
    const next = [...(history ?? []), now].slice(-HISTORY_LENGTH);
    await Bun.write(keepFile, `${JSON.stringify({ history: next }, null, 2)}\n`);
  }
  const said =
    keepFile !== undefined && history === null
      ? ['no baseline yet: this run is recorded, nothing compared']
      : [];
  return { lines: [...said, ...lines], code: regressed ? 1 : 0 };
};

if (import.meta.main) {
  const { lines, code } = await main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}
