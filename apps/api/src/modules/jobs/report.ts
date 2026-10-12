/**
 * What `jobs:status` says (D-30): for every job the deployment should be running, whether it last
 * succeeded lately. A job with no row has never succeeded — the scheduler nobody installed — and is
 * said as such; a job past two days without a success, or failing since its last one, is overdue.
 * Nothing healthy means the command exits non-zero, so a monitor can watch it.
 */

/** A daily job that missed one night is late; one that missed two is broken. */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

interface JobRecord {
  readonly job_name: string;
  readonly last_success_at: Date | null;
  readonly consecutive_failures: number;
  readonly last_error: string | null;
}

export const jobReport = (
  known: readonly string[],
  records: readonly JobRecord[],
  now: Date,
): { readonly lines: readonly string[]; readonly healthy: boolean } => {
  const width = Math.max(...known.map((name) => name.length));
  let healthy = true;
  const lines = known.map((name) => {
    const record = records.find((candidate) => candidate.job_name === name);
    const label = name.padEnd(width);
    if (record?.last_success_at == null) {
      healthy = false;
      return `never    ${label}  has never succeeded: is the scheduler installed?`;
    }
    const success = `last success ${record.last_success_at.toISOString()}`;
    const late = now.getTime() - record.last_success_at.getTime() > STALE_AFTER_MS;
    if (!late && record.consecutive_failures === 0) return `ok       ${label}  ${success}`;
    healthy = false;
    const failures = record.consecutive_failures;
    const since =
      failures === 0
        ? ''
        : `, ${String(failures)} failure${failures === 1 ? '' : 's'} since: ${record.last_error ?? ''}`;
    return `overdue  ${label}  ${success}${since}`;
  });
  return { lines, healthy };
};
