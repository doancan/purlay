/**
 * `bun run export:workspace <slug> <directory>` — an operator exports a workspace (D-27 §3, D-140):
 * every channel, as NDJSON per table, into a new directory nobody else can read. Not a scheduled job
 * (D-30 amended): it runs when somebody asks. The directory must not exist; the export is written
 * beside it as `<directory>.partial` and renamed when it is whole.
 *
 * Mount a volume for the directory when running it in a container, or it goes with the container.
 * Prints where it wrote and how many rows; never anybody's words.
 */
import { createDatabase } from '@purlay/db';
import { everyChannel, exportWorkspace } from '../modules/export/export';
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
  const [slug, directory, ...rest] = process.argv.slice(2);
  if (slug === undefined || directory === undefined || rest.length > 0) {
    process.stderr.write('usage: bun run export:workspace <slug> <directory>\n');
    process.exitCode = 2;
  } else {
    const workspace = await database
      .selectFrom('workspaces')
      .select(['id', 'slug', 'name'])
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (workspace === undefined) {
      process.stderr.write('no workspace has that address\n');
      process.exitCode = 2;
    } else {
      const { path, manifest } = await exportWorkspace(
        { database, clock: systemClock, log, storage: storeFor(config) },
        workspace,
        {
          kind: 'all',
          workspaceId: workspace.id,
          channelIds: await everyChannel(database, workspace.id),
        },
        directory,
      );
      process.stdout.write(
        `${path}\n${JSON.stringify({ ...manifest.tables, files: manifest.blobs.count })}\n`,
      );
      // A file the store did not have while its row is there: the export is written, and incomplete.
      if (manifest.blobs.missing.length > 0) {
        process.stderr.write(
          `${String(manifest.blobs.missing.length)} file(s) missing from storage; the manifest names them\n`,
        );
        process.exitCode = 1;
      }
    }
  }
} finally {
  await database.destroy();
}
