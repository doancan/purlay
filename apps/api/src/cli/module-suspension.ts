/**
 * `bun run module:suspend <id> --reason "<why>" [--force] [--cluster-ready]` and `bun run module:resume <id>` — the operator's
 * twin of the console's stop (D-296): a module is stopped for every workspace and every node, and let run again, through the one writer
 * the console calls, on the server's trail with the reason. Both are the same on a second run. Prints the module, what came of it
 * and every other module that stopped, or came back, with it; never anybody's words but the operator's own reason.
 *
 * Exits 2 on a module it cannot use, a stop with no reason, or a stop that takes the product down (chat) without `--force`; 1 when the
 * server is clustered (`REDIS_URL`) and `--cluster-ready` does not say that every node reads the stops: the command cannot see the
 * cluster, the serving process can, and a node that does not read the table would go on serving the module. Nodes believe it within
 * `SUSPENSION_TTL_MS` of the commit; nothing is restarted.
 */
import { createDatabase } from '@purlay/db';
import { compositionFor } from '../composition';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { applySuspension } from '../modules/suspension/apply';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { AppError } from '../platform/errors';
import { createLogger } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';

const USAGE =
  'usage: bun run module:suspend <id> --reason "<why>" [--force] [--cluster-ready]\n       bun run module:resume <id>';

const config = loadConfig(process.env);
const log = createLogger({ level: config.LOG_LEVEL });
const composition = compositionFor(config.MODULES, config.WORKSPACE_MODULES);
const catalogue = {
  carried: composition.bundled.map((module) => module.manifest),
  mode: composition.entitlementMode,
};
const fail = (message: string, code = 2): void => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};

const [verb, module, ...rest] = process.argv.slice(2);
const flag = (name: string): boolean => rest.includes(name);
const at = rest.indexOf('--reason');
const reason = at === -1 ? undefined : rest[at + 1];
const known = new Set(['--reason', reason, '--force', '--cluster-ready']);
const stopping = verb === 'suspend';
sendAuditLinesTo(log);

if (
  (verb !== 'suspend' && verb !== 'resume') ||
  module === undefined ||
  rest.some((arg) => !known.has(arg)) ||
  (!stopping && rest.length > 0)
) {
  fail(USAGE);
} else if (stopping && config.REDIS_URL !== undefined && !flag('--cluster-ready')) {
  fail(
    'this server is clustered (REDIS_URL): once every node runs a release that reads the stopped modules, say so with --cluster-ready',
    1,
  );
} else {
  const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });
  try {
    const result = await atomicallyOn(database)(
      async (tx) =>
        await applySuspension(
          tx,
          systemClock,
          catalogue,
          { source: 'cli', userId: null },
          {
            module,
            state: stopping ? 'suspended' : 'running',
            reason,
            force: flag('--force'),
          },
        ),
    );
    const also = result.alsoAffected.length === 0 ? '' : `, with ${result.alsoAffected.join(', ')}`;
    process.stdout.write(
      `${module} ${stopping ? 'stopped' : 'running again'}${also}${result.changed ? '' : ' (no change)'}\n`,
    );
    if (result.changed)
      process.stdout.write('every node believes it within a few seconds; nothing is restarted\n');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    fail(
      error.body.code === 'VALIDATION_FAILED'
        ? // The same sentence as the console's, in the command's own word for it.
          Object.values(error.body.details.fields).join('\n').replace('force: true', '--force')
        : error.body.message,
      2,
    );
  } finally {
    await database.destroy();
  }
}
