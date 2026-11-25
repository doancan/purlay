/**
 * `bun run outbox:ledger <workspace slug> [--fact <id>] [--consumer <module>] [--limit <n>]` (#1305): what the ledger says was
 * delivered, newest first, for an operator who must prove it. The words of the command, kept here so a test can run them against a
 * database without a process. Prints ids, the type and the time, never a payload. Exits 2 on a command it cannot make (no workspace
 * address, a fact id that is not one, a module name that is not one, a limit that is not a whole number from 1 to the read's most, an
 * address no workspace has) and says so; 0 otherwise, an empty answer included, with a note when the ledger is off.
 */
import type { Executor } from '@purlay/db';
import { LEDGER_READ_MAX, readLedger } from './outbox-ledger';

const LEDGER_USAGE =
  'usage: bun run outbox:ledger <workspace slug> [--fact <id>] [--consumer <module>] [--limit <n>]';

export interface LedgerRun {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const FACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;

const refuse = (err: string): LedgerRun => ({ code: 2, out: '', err: `${err}\n` });

export const runLedger = async (
  argv: readonly string[],
  environment: {
    readonly database: Executor;
    /** Whether the ledger is being written (`OUTBOX_LEDGER_DAYS` is set), so an empty answer is read for what it is. */
    readonly enabled: boolean;
  },
): Promise<LedgerRun> => {
  const [slug, ...rest] = argv;
  if (slug === undefined || slug.startsWith('--')) return refuse(LEDGER_USAGE);
  const given: Record<string, string> = {};
  for (let at = 0; at < rest.length; at += 2) {
    const flag = rest[at];
    const value = rest[at + 1];
    if (
      (flag !== '--fact' && flag !== '--consumer' && flag !== '--limit') ||
      value === undefined ||
      flag in given
    )
      return refuse(LEDGER_USAGE);
    given[flag] = value;
  }
  const fact = given['--fact'];
  const consumer = given['--consumer'];
  const rawLimit = given['--limit'];
  if (fact !== undefined && !FACT_ID.test(fact)) return refuse(`"${fact}" is not a fact id`);
  if (consumer !== undefined && !MODULE_ID.test(consumer))
    return refuse(`"${consumer}" is not a module name`);
  if (rawLimit !== undefined && !/^[1-9]\d{0,3}$/.test(rawLimit))
    return refuse(`--limit is a whole number from 1 to ${String(LEDGER_READ_MAX)}`);
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && limit > LEDGER_READ_MAX)
    return refuse(`--limit is a whole number from 1 to ${String(LEDGER_READ_MAX)}`);

  const workspace = await environment.database
    .selectFrom('workspaces')
    .select('id')
    .where('slug', '=', slug)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (workspace === undefined) return refuse(`no workspace has the address "${slug}"`);

  const entries = await readLedger(environment.database, workspace.id, {
    ...(fact === undefined ? {} : { factId: fact }),
    ...(consumer === undefined ? {} : { consumer }),
    ...(limit === undefined ? {} : { limit }),
  });
  const lines = entries.map(
    (entry) =>
      `${entry.deliveredAt.toISOString()}  ${entry.consumer}  ${entry.type}  ${entry.factId}  (from ${entry.producer})`,
  );
  const note = environment.enabled
    ? ''
    : 'the ledger is off (OUTBOX_LEDGER_DAYS is not set): nothing is being recorded now, and what is shown was recorded earlier\n';
  const body = lines.length === 0 ? 'no delivery recorded\n' : `${lines.join('\n')}\n`;
  return { code: 0, out: `${note}${body}`, err: '' };
};
