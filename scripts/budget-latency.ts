/**
 * The latency budgets' door (`PRD.md` §5, D-49, #73): the measurement is the API's own command
 * (`apps/api/src/cli/budget-latency.ts`), which signs people in the way the API does; this says
 * plainly when there is no database to measure against — a banner locally, a refusal in CI, as
 * `budget-api.ts` does — and otherwise runs it with the arguments it was given.
 *
 *   bun run budget:latency [-- --record <file> | --baseline <file>]
 */
import { reachable } from './database-reachable';

const COMMAND = 'apps/api/src/cli/budget-latency.ts';

export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  args: readonly string[],
  run: (args: readonly string[]) => Promise<number> = async (given) =>
    await Bun.spawn(['bun', COMMAND, ...given], { stdout: 'inherit', stderr: 'inherit' }).exited,
): Promise<{ readonly line: string | null; readonly code: number }> => {
  const url = environment['DATABASE_URL'] ?? '';
  if (url === '' || !(await reachable(url))) {
    const reason =
      url === '' ? 'DATABASE_URL is not set' : `nothing answers at ${new URL(url).host}`;
    return environment['CI'] === 'true'
      ? {
          line: `budget:latency — ${reason}, and CI provides the database. Refusing to skip a budget.`,
          code: 1,
        }
      : { line: `budget:latency — ${reason}: the latency budgets were NOT measured.`, code: 0 };
  }
  return { line: null, code: await run(args) };
};

/** Says what the door said, if anything, and answers the exit code. */
export const report = (
  result: { readonly line: string | null; readonly code: number },
  print: { readonly out: (line: string) => void; readonly error: (line: string) => void } = {
    out: console.log,
    error: console.error,
  },
): number => {
  if (result.line !== null) (result.code === 0 ? print.out : print.error)(result.line);
  return result.code;
};

if (import.meta.main) process.exit(report(await main(process.env, process.argv.slice(2))));
