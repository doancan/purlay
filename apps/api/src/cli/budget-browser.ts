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
 * tests assert it on a developer's machine. Here a number fails when it jumped past main's last, and
 * a number main measured that this run did not is a failure too: a measurement that quietly stopped
 * is not a pass. A run that measured nothing at all is refused.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { jumped, optionOf } from './budget-latency';

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

/** The lines to print, and whether the run regressed against the baseline, if there is one. */
export const judge = (
  now: Measured,
  baseline: Measured | null,
): { readonly regressed: boolean; readonly lines: readonly string[] } => {
  let regressed = false;
  const lines: string[] = [];
  for (const { name } of MEASURES) {
    const value = now[name];
    const before = baseline?.[name];
    const was = before === undefined ? '' : `, was ${before.toFixed(1)} ms`;
    if (value === undefined) {
      if (before === undefined) continue;
      regressed = true;
      lines.push(`${name}: not measured${was} — MISSING`);
      continue;
    }
    const worse = jumped(value, before);
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
  const baseline = kept === undefined ? null : (kept as Measured);
  const { regressed, lines } = judge(now, baseline);
  // A regression is not adopted: the next run is judged against the last one that passed.
  if (keepFile !== undefined && !regressed) {
    await Bun.write(keepFile, `${JSON.stringify(now, null, 2)}\n`);
  }
  const said =
    keepFile !== undefined && baseline === null
      ? ['no baseline yet: this run is recorded, nothing compared']
      : [];
  return { lines: [...said, ...lines], code: regressed ? 1 : 0 };
};

if (import.meta.main) {
  const { lines, code } = await main(process.argv.slice(2));
  for (const line of lines) console.log(line);
  process.exit(code);
}
