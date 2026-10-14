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

const config = loadConfig(process.env);
const log = createLogger({ level: config.LOG_LEVEL });
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
        { database, clock: systemClock, log },
        workspace,
        {
          kind: 'all',
          workspaceId: workspace.id,
          channelIds: await everyChannel(database, workspace.id),
        },
        directory,
      );
      process.stdout.write(`${path}\n${JSON.stringify(manifest.tables)}\n`);
    }
  }
} finally {
  await database.destroy();
}
