/**
 * `bun run quota:show <slug>`, `quota:set <slug> <kind> <limit> --reason "<why>"` and `quota:clear <slug> <kind>` (#1306): the
 * operator's words for `operate.ts`, kept here so a test can run them against a database without a process. Exits 2 on a command
 * it cannot make (a kind nobody knows, a limit that is not a whole number, a set with no reason, a workspace that is not there) and
 * says so; 0 otherwise, and says what is in force. The same again changes nothing.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { QUOTA_KINDS, isQuotaKind } from '../../platform/quotas';
import { QUOTA_REASON_MAX, operateQuota, parseLimit, showQuotas, type Defaults } from './operate';

const QUOTA_USAGE = [
  'usage: bun run quota:show <workspace slug>',
  '       bun run quota:set <workspace slug> <kind> <limit> --reason "<why>"',
  '       bun run quota:clear <workspace slug> <kind>',
  `kinds: ${Object.keys(QUOTA_KINDS).join(', ')}`,
  'the storage quota is its own command: bun run storage:quota <workspace slug> [<size>]',
].join('\n');

export interface QuotaRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

export interface QuotaEnvironment {
  /** Runs the work in one transaction, as the command is one change. */
  readonly atomically: <T>(work: (executor: Executor) => Promise<T>) => Promise<T>;
  readonly clock: Clock;
  readonly defaults: Defaults;
}

const refuse = (err: string): QuotaRun => ({ code: 2, out: '', err: `${err}\n` });

const said = (limit: number | null): string => (limit === null ? 'not limited' : String(limit));

export const runQuota = async (
  argv: readonly string[],
  environment: QuotaEnvironment,
): Promise<QuotaRun> => {
  const [verb, slug, kind, rawLimit, ...rest] = argv;
  if (verb === undefined || slug === undefined) return refuse(QUOTA_USAGE);

  if (verb === 'show') {
    if (kind !== undefined) return refuse(QUOTA_USAGE);
    const lines = await environment.atomically(
      async (executor) => await showQuotas(executor, slug, environment.defaults),
    );
    if (lines === null) return refuse(`no workspace has the address "${slug}"`);
    const out = lines
      .map(
        (line) =>
          `${line.kind} (${line.counts}): ${said(line.inForce)}${
            line.override === null ? ' [default]' : ` [set by the operator: ${line.reason ?? ''}]`
          }`,
      )
      .join('\n');
    return {
      code: 0,
      out: `${out}\n(defaults as this command's environment reads them; the server's own may differ if its environment does)\n`,
      err: '',
    };
  }

  if (verb !== 'set' && verb !== 'clear') return refuse(QUOTA_USAGE);
  if (kind === undefined || !isQuotaKind(kind))
    return refuse(`"${kind ?? ''}" is not a kind of limit\n${QUOTA_USAGE}`);

  let limit: number | null = null;
  let reason: string | undefined;
  if (verb === 'set') {
    const parsed = rawLimit === undefined ? null : parseLimit(rawLimit);
    if (parsed === null)
      return refuse(`"${rawLimit ?? ''}" is not a limit: a whole number from 0\n${QUOTA_USAGE}`);
    limit = parsed;
    const at = rest.indexOf('--reason');
    reason = at === -1 ? undefined : rest[at + 1];
    if (rest.some((word, i) => word !== '--reason' && i !== at + 1)) return refuse(QUOTA_USAGE);
  } else if (rawLimit !== undefined || rest.length > 0) {
    return refuse(QUOTA_USAGE);
  }

  const done = await environment.atomically(
    async (executor) =>
      await operateQuota(executor, environment.clock, { slug, kind, limit, reason }),
  );
  if (done.kind === 'no-workspace') return refuse(`no workspace has the address "${slug}"`);
  if (done.kind === 'no-reason') return refuse('a limit needs its reason: --reason "<why>"');
  if (done.kind === 'reason-too-long')
    return refuse(`a reason is at most ${String(QUOTA_REASON_MAX)} characters`);
  const now = limit === null ? 'back to the default' : said(limit);
  return {
    code: 0,
    out: `${kind} of ${slug}: ${now}${done.changed ? '' : ' (no change)'}\n`,
    err: '',
  };
};
