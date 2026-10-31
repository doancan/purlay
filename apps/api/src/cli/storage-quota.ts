/**
 * `bun run storage:quota <workspace slug> [<size>]` — an operator reads a workspace's storage and its
 * quota, and with a size sets the quota (D-173, `CONFIG.md`). The quota is the operator's disk, so it is
 * set here and never in the product; an owner sees it on Settings → Data & retention.
 *
 * A size is whole bytes or a whole number of `KiB`, `MiB`, `GiB` or `TiB` (`10GiB`). It prints the
 * storage used and the quota, and says so when what is used is already past the new quota: nothing is
 * deleted, and uploads are refused until there is room.
 */
import { createDatabase } from '@purlay/db';
import { operateQuota, parseQuota, saidBytes } from '../modules/attachments/quota';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { createLogger } from '../platform/logging';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { atomicallyOn } from '../platform/transactions';

const [slug, size, ...rest] = process.argv.slice(2);
const quota = size === undefined ? null : parseQuota(size);

if (slug === undefined || rest.length > 0 || (size !== undefined && quota === null)) {
  process.stderr.write(
    'usage: bun run storage:quota <workspace slug> [<bytes> | <n>KiB | <n>MiB | <n>GiB | <n>TiB]\n',
  );
  process.exitCode = 2;
} else {
  const config = loadConfig(process.env);
  const log = createLogger({ level: config.LOG_LEVEL });
  // Every entry this process writes to the trail is also a line of its log, ids only (D-222).
  sendAuditLinesTo(log);
  const database = createDatabase({ ...databaseConnection(config, log), poolSize: 1 });
  try {
    const report = await atomicallyOn(database)(
      async (transaction) => await operateQuota(transaction, systemClock, slug, quota),
    );
    if (report === null) {
      process.stderr.write(`no workspace has the slug ${slug}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `${slug}: ${saidBytes(report.usedBytes)} used of ${saidBytes(report.quotaBytes)}${quota === null ? '' : ' (quota set)'}\n`,
      );
      if (report.usedBytes > report.quotaBytes) {
        process.stdout.write(
          'more is used than the quota allows: uploads are refused until there is room\n',
        );
      }
    }
  } finally {
    await database.destroy();
  }
}
