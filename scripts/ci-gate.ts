/**
 * The required `verify` check, as one verdict over the jobs it stands for (#791).
 *
 * The static checks and the whole test suite are separate jobs, so the unit tests run once — in
 * `schema`, with the integration tests and coverage — instead of once there and once more alone.
 * Branch protection still requires `verify`, and `verify` means all of them: this passes only when every
 * job it judges *succeeded*. A failure, a cancellation, a skip, a missing result or a missing job is a
 * refusal, because a skipped required check counts as passed and a gate that reads "nothing failed"
 * passes on nothing having run (`CONTRIBUTING.md` §6.4).
 *
 * The browser jobs are judged too (D-226), and so are `modules`, the job that starts the API once per `MODULES`
 * value, and `module-suites`, the suites run once per cell, and `mutations-changed`, the mutations a pull request adds or changes: a change they cannot see skips them, and only then is their skip a pass — when `changes` succeeded
 * and said so. Anything else, a skip included, is a refusal.
 *
 *   bun run ci:gate        in CI: reads `NEEDS`, the job's `toJSON(needs)`
 */

/** The jobs `verify` stands for. `ci.yml`'s `needs:` for the job is bound to this list by a test. */
export const GATED = [
  'static',
  'schema',
  'api-measurements',
  'changes',
  'browser',
  'modules',
  'module-suites',
  'cohort-measurements',
  'mutations-changed',
] as const;

/**
 * The jobs a change can rightly skip, each with the output of `changes` that says so: the browser jobs by `browser`, and the
 * two that start the API (the matrix on a started process, and the suites per cell) by `modules`, and the mutations a pull request
 * adds or changes by `mutations`.
 */
const SKIPPABLE: Readonly<Record<string, string>> = {
  browser: 'browser',
  modules: 'modules',
  'module-suites': 'modules',
  'cohort-measurements': 'modules',
  'mutations-changed': 'mutations',
};

/** Whether `changes` succeeded and said `output` is `false`: this change cannot move what that job sees. */
const notNeeded = (jobs: Record<string, unknown>, output: string): boolean => {
  const changes = jobs['changes'];
  if (typeof changes !== 'object' || changes === null) return false;
  const { result, outputs } = changes as { result?: unknown; outputs?: unknown };
  return (
    result === 'success' &&
    typeof outputs === 'object' &&
    outputs !== null &&
    (outputs as Record<string, unknown>)[output] === 'false'
  );
};

/** Every reason the results do not pass; empty when they do. */
export const judge = (needs: string): string[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(needs);
  } catch {
    return ['the results of the jobs it needs are not JSON'];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return ['the results of the jobs it needs are not an object of jobs'];
  }
  const jobs = parsed as Record<string, unknown>;
  const reasons: string[] = [];
  for (const name of GATED) {
    if (!(name in jobs)) {
      reasons.push(`${name} is not among the jobs this one needs`);
      continue;
    }
    const job = jobs[name];
    const result =
      typeof job === 'object' && job !== null && 'result' in job && typeof job.result === 'string'
        ? job.result
        : '';
    const skippable = SKIPPABLE[name];
    const skipIsRight =
      skippable !== undefined && result === 'skipped' && notNeeded(jobs, skippable);
    if (result !== 'success' && !skipIsRight) {
      reasons.push(`${name} ended ${result === '' ? 'with no result' : result}`);
    }
  }
  for (const name of Object.keys(jobs)) {
    if (!(GATED as readonly string[]).includes(name)) {
      reasons.push(`${name} is needed but the gate does not judge it`);
    }
  }
  return reasons;
};

/** The verdict as the job reads it: every reason on standard error and 1, or the pass line and 0. */
export const main = (environment: Readonly<Record<string, string | undefined>>): number => {
  const reasons = judge(environment['NEEDS'] ?? '');
  for (const reason of reasons) console.error(`verify — ${reason}`);
  if (reasons.length > 0) return 1;
  console.log(`verify — ${GATED.join(', ')}: each succeeded, or was rightly skipped`);
  return 0;
};

if (import.meta.main) process.exit(main(process.env));
