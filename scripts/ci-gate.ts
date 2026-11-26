/**
 * The required `verify` check, as one verdict over the jobs it stands for (#791).
 *
 * The static checks and the whole test suite are separate jobs, so the unit tests run once — in the areas of
 * `schema-area`, with the integration tests and coverage, which `schema` puts together and holds to the floor
 * (D-340) — instead of once there and once more alone.
 * Branch protection still requires `verify`, and `verify` means all of them: this passes only when every
 * job it judges *succeeded*. A failure, a cancellation, a skip, a missing result or a missing job is a
 * refusal, because a skipped required check counts as passed and a gate that reads "nothing failed"
 * passes on nothing having run (`CONTRIBUTING.md` §6.4).
 *
 * The browser jobs are judged too (D-226), and so are `modules`, the job that starts the API once per `MODULES`
 * value, and `module-suites`, the suites run once per cell, and `mutations-changed`, the mutations a pull request adds or changes: a change they cannot see skips them, and only then is their skip a pass — when `changes` succeeded
 * and said so. Anything else, a skip included, is a refusal.
 *
 * A *light* change (documents, or a version bump) skips `schema`'s coverage run for `light-suite`, which runs every test
 * that needs no database; and a commit on main whose content was *already verified* skips the heavy jobs (D-332). Each skip
 * is a pass only when `scope` succeeded and said so, and `light-suite` is itself judged: it must have succeeded for
 * the change it was run for, and may be skipped only when the change was not light.
 *
 *   bun run ci:gate        in CI: reads `NEEDS`, the job's `toJSON(needs)`
 */

/** The jobs `verify` stands for. `ci.yml`'s `needs:` for the job is bound to this list by a test. */
export const GATED = [
  'scope',
  'static',
  'schema',
  'schema-area',
  'light-suite',
  'api-measurements',
  'changes',
  'browser',
  'modules',
  'module-suites',
  'cohort-measurements',
  'mutations-changed',
] as const;

/** One reason a skip is right: `job` succeeded and its output `output` is `value`. */
interface Skip {
  readonly job: string;
  readonly output: string;
  readonly value: 'true' | 'false';
}

/**
 * The jobs that can rightly be skipped, each with every output that says so: the browser jobs by `browser`, the two
 * that start the API (the matrix on a started process, and the suites per cell) by `modules`, the mutations a pull
 * request adds or changes by `mutations`; `schema` and its areas `schema-area` by a *light* change, or by content already verified, and `static`
 * and `module-suites` by the latter; `light-suite` by a change that was not light.
 */
const SKIPPABLE: Readonly<Record<string, readonly Skip[]>> = {
  browser: [{ job: 'changes', output: 'browser', value: 'false' }],
  modules: [{ job: 'changes', output: 'modules', value: 'false' }],
  'module-suites': [
    { job: 'changes', output: 'modules', value: 'false' },
    { job: 'scope', output: 'reuse', value: 'true' },
  ],
  'cohort-measurements': [{ job: 'changes', output: 'modules', value: 'false' }],
  'mutations-changed': [{ job: 'changes', output: 'mutations', value: 'false' }],
  static: [{ job: 'scope', output: 'reuse', value: 'true' }],
  schema: [
    { job: 'scope', output: 'light', value: 'true' },
    { job: 'scope', output: 'reuse', value: 'true' },
  ],
  // The areas `schema` puts together (D-340) are skipped for exactly the reasons the whole was.
  'schema-area': [
    { job: 'scope', output: 'light', value: 'true' },
    { job: 'scope', output: 'reuse', value: 'true' },
  ],
  'light-suite': [{ job: 'scope', output: 'light', value: 'false' }],
};

/** Whether `skip.job` succeeded and said its output is `skip.value`: this change cannot move what that job sees. */
const said = (jobs: Record<string, unknown>, skip: Skip): boolean => {
  const job = jobs[skip.job];
  if (typeof job !== 'object' || job === null) return false;
  const { result, outputs } = job as { result?: unknown; outputs?: unknown };
  return (
    result === 'success' &&
    typeof outputs === 'object' &&
    outputs !== null &&
    (outputs as Record<string, unknown>)[skip.output] === skip.value
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
    const skipIsRight =
      result === 'skipped' && (SKIPPABLE[name] ?? []).some((skip) => said(jobs, skip));
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
