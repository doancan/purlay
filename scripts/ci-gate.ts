/**
 * The required `verify` check, as one verdict over the jobs it stands for (#791).
 *
 * The static checks and the whole test suite are separate jobs, so the unit tests run once — in
 * `schema`, with the integration tests and coverage — instead of once there and once more alone.
 * Branch protection still requires `verify`, and `verify` now means both: this passes only when every
 * job it judges *succeeded*. A failure, a cancellation, a skip, a missing result or a missing job is a
 * refusal, because a skipped required check counts as passed and a gate that reads "nothing failed"
 * passes on nothing having run (`CONTRIBUTING.md` §6.4).
 *
 *   bun run ci:gate        in CI: reads `NEEDS`, the job's `toJSON(needs)`
 */

/** The jobs `verify` stands for. `ci.yml`'s `needs:` for the job is bound to this list by a test. */
export const GATED = ['static', 'schema'] as const;

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
    if (result !== 'success') {
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
  console.log(`verify — ${GATED.join(' and ')} succeeded`);
  return 0;
};

if (import.meta.main) process.exit(main(process.env));
