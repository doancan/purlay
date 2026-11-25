/**
 * `bun run outbox:ledger <workspace slug> [--fact <id>] [--consumer <module>] [--limit <n>]` (#1305): the words are
 * `platform/outbox-ledger-command.ts`'s; this reads the configuration, opens the database and prints.
 */
import { createDatabase } from '@purlay/db';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { createLogger } from '../platform/logging';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { runLedger } from '../platform/outbox-ledger-command';

const config = loadConfig(process.env);
const log = createLogger({ level: config.LOG_LEVEL });
sendAuditLinesTo(log);
const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });
try {
  const [, , ...argv] = process.argv;
  const run = await runLedger(argv, {
    database,
    enabled: config.OUTBOX_LEDGER_DAYS !== undefined,
  });
  process.stdout.write(run.out);
  process.stderr.write(run.err);
  process.exitCode = run.code;
} finally {
  await database.destroy();
}
