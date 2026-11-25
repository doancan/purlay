/**
 * `bun run quota:show|set|clear` (#1306): what one workspace may do beyond or short of what every workspace may. The words are
 * `modules/quotas/command.ts`'s; this reads the configuration, opens the database and prints.
 */
import { createDatabase } from '@purlay/db';
import { ISSUES_PER_WORKSPACE_MAX } from '@purlay/types';
import { runQuota } from '../modules/quotas/command';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { createLogger } from '../platform/logging';
import { atomicallyOn } from '../platform/transactions';

const config = loadConfig(process.env);
const log = createLogger({ level: config.LOG_LEVEL });
sendAuditLinesTo(log);
const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });
try {
  const [, , ...argv] = process.argv;
  const run = await runQuota(argv, {
    atomically: async (work) => await atomicallyOn(database)(async (tx) => await work(tx)),
    clock: systemClock,
    defaults: {
      deliveries_per_minute: config.WORKSPACE_DELIVERIES_PER_MINUTE ?? null,
      'issues:rows': ISSUES_PER_WORKSPACE_MAX,
    },
  });
  process.stdout.write(run.out);
  process.stderr.write(run.err);
  process.exitCode = run.code;
} finally {
  await database.destroy();
}
