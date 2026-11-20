/**
 * `bun run outbox:requeue <id>… --reason "<why>"` and `bun run outbox:discard <id>… --reason "<why>"` — the operator's twin of the
 * console's requeue and discard of the outbox (D-288 §12), for a server whose administrator cannot sign in. The same writer as
 * `POST /api/server/outbox/requeue` and `/discard`, with the same limits on the ids and the reason, and each delivery it changes on
 * the server's trail with that reason, the actor left empty as `module:suspend` leaves it (D-296). Prints what became of each id,
 * never a payload.
 *
 * Exits 2 on arguments it cannot use (no id, an id that is not one, an id written twice, more than the console takes, a missing or
 * blank reason), and writes nothing; 1 when an id was not found or its delivery is over (`delivered` or `skipped`), the others being
 * changed all the same, as the console does; 0 otherwise. A second run changes nothing and records nothing.
 */
import { Value } from '@sinclair/typebox/value';
import { createDatabase } from '@purlay/db';
import { ServerOutboxChangeRequest } from '@purlay/types';
import { applyOutboxChange } from '../modules/administration/outbox';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { createLogger } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';

const USAGE =
  'usage: bun run outbox:requeue <id>… --reason "<why>"\n       bun run outbox:discard <id>… --reason "<why>"';
const IDS_MAX = ServerOutboxChangeRequest.properties.ids.maxItems ?? 0;
const REASON_MAX = ServerOutboxChangeRequest.properties.reason.maxLength ?? 0;

const fail = (message: string, code = 2): void => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};

/** What is wrong with the arguments, in the operator's words; undefined when the console would take them. */
const refusalOf = (
  verb: string | undefined,
  ids: readonly string[],
  reason: string | undefined,
): string | undefined => {
  if ((verb !== 'requeue' && verb !== 'discard') || ids.length === 0) return USAGE;
  if (ids.length > IDS_MAX) return `at most ${String(IDS_MAX)} ids at a time`;
  const malformed = ids.find((id) => !Value.Check(ServerOutboxChangeRequest.properties.ids, [id]));
  if (malformed !== undefined) return `not a delivery id: ${malformed}`;
  if (new Set(ids).size !== ids.length) return 'an id is written twice';
  if (reason === undefined || reason.trim() === '' || reason.length > REASON_MAX)
    return `--reason "<why>" is needed: 1 to ${String(REASON_MAX)} characters, not blank`;
  return undefined;
};

const [verb, ...rest] = process.argv.slice(2);
const at = rest.indexOf('--reason');
const reason = at === -1 ? undefined : rest[at + 1];
const ids = rest.filter((_arg, index) => at === -1 || (index !== at && index !== at + 1));
const refusal = refusalOf(verb, ids, reason);

if (refusal !== undefined || (verb !== 'requeue' && verb !== 'discard') || reason === undefined) {
  fail(refusal ?? USAGE);
} else {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.LOG_LEVEL });
  sendAuditLinesTo(log);
  const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });
  try {
    const { results } = await atomicallyOn(database)(
      async (tx) => await applyOutboxChange(tx, systemClock, null, verb, { ids, reason }),
    );
    for (const { id, result } of results) process.stdout.write(`${id} ${result}\n`);
    const changed = results.filter((entry) => entry.result === 'changed').length;
    process.stdout.write(
      changed === 0
        ? 'nothing changed, and nothing was written on the trail\n'
        : `${String(changed)} ${verb === 'requeue' ? 'requeued' : 'discarded'}, on the server's trail with the reason\n`,
    );
    if (results.some((entry) => entry.result === 'not_found' || entry.result === 'refused')) {
      fail('an id was not found, or its delivery is over (delivered or skipped)', 1);
    }
  } finally {
    await database.destroy();
  }
}
