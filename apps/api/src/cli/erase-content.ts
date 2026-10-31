/**
 * `bun run erase:content <username | email | user id> (--workspace <slug> | --all)` — an operator
 * empties every message a person wrote, and removes their files (D-27 §2, D-139 §7). For a request the
 * controller has accepted where anonymised authorship is not enough; the person's account is another
 * act, their own (`POST /api/me/erase`).
 *
 * Per workspace by default — in the cloud each workspace's customer is the controller (D-28) — and
 * `--all` for a self-hoster who is the controller of every one. It prints what it did in each, by id
 * and in counts; never anybody's words. An open screen keeps the words until it reloads: this process
 * has no bus to tell it (D-139 §7).
 */
import { createDatabase } from '@purlay/db';
import { eraseContent, planContentErasure } from '../modules/users/content-erasure';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { createLogger } from '../platform/logging';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { storeFor } from '../platform/storage';

const config = loadConfig(process.env);
const log = createLogger({ level: config.LOG_LEVEL });
// Every entry this process writes to the trail is also a line of its log, ids only (D-222).
sendAuditLinesTo(log);
const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });

try {
  const plan = await planContentErasure(database, process.argv.slice(2));
  if (!plan.ok) {
    process.stderr.write(`${plan.reason}\n`);
    process.exitCode = 2;
  } else {
    const done = await eraseContent(
      { database, clock: systemClock, log, storage: storeFor(config) },
      plan.userId,
      plan.workspaceIds,
    );
    for (const workspace of done) {
      process.stdout.write(
        `${workspace.workspaceId}: ${String(workspace.messages)} messages emptied, ${String(workspace.files)} files removed${workspace.leftBehind === 0 ? '' : `, ${String(workspace.leftBehind)} left in storage`}\n`,
      );
    }
    if (done.some((workspace) => workspace.leftBehind > 0)) process.exitCode = 1;
  }
} finally {
  await database.destroy();
}
