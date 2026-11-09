/**
 * `bun run entitlements:apply --file <editions.json> [--dry-run] [--cluster-ready]` — an operator applies an edition file (D-292): each workspace it
 * lists is given the modules of its edition and none of the others, in one transaction, through the one writer the console uses.
 * `--dry-run` says what would change and which workspace each address in the file resolved to, and changes nothing. Run again it changes nothing. Prints counts by module and state, and
 * workspace addresses; never anybody's words. Exits 2 on a file or a workspace it cannot use, 1 when the file takes grants away on a clustered server (`REDIS_URL`) and
 * `--cluster-ready` does not say that every node reads grants: the command cannot see the cluster, the serving process can. `--cluster-ready`
 * is the operator's word and nothing checks it: it is warned of in the log and recorded with each grant it wrote (D-292). Open pages of the workspaces it changed correct themselves at their next request for a module they no longer have.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createDatabase } from '@purlay/db';
import { compositionFor } from '../composition';
import { applyEdition, planEdition, readEditionFile } from '../modules/entitlements/edition';
import { restricts } from '../modules/entitlements/peers';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { createLogger } from '../platform/logging';
import { sendAuditLinesTo } from '../modules/audit/lines';
import { AppError } from '../platform/errors';

const USAGE =
  'usage: bun run entitlements:apply --file <editions.json> [--dry-run] [--cluster-ready]\nexit codes: 0 applied (or nothing to do), 1 the file takes grants away on a clustered server without --cluster-ready, 2 the file or a workspace cannot be used';
// Before the configuration is read: asking for usage must not need a database.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

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

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const clusterReady = args.includes('--cluster-ready');
const at = args.indexOf('--file');
const path = at === -1 ? undefined : args[at + 1];
// A dry run writes no entry, so it says none: the line of the trail is written as the entry is made, and a transaction undone has no entry.
if (!dryRun) sendAuditLinesTo(log);

if (
  path === undefined ||
  args.filter((arg) => arg !== '--dry-run' && arg !== '--cluster-ready').length !== 2
) {
  fail(USAGE);
} else {
  const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });
  try {
    const { file, problems } = readEditionFile(readFileSync(path, 'utf8'));
    if (file === undefined) {
      fail(problems.map((problem) => `${path}: ${problem}`).join('\n'));
    } else {
      const found = await database
        .selectFrom('workspaces')
        .select(['id', 'slug'])
        .where('slug', 'in', Object.keys(file.workspaces))
        .where('deleted_at', 'is', null)
        .execute();
      const resolved = new Map(found.map((workspace) => [workspace.slug, workspace.id]));
      const plan = planEdition(file, catalogue, resolved, systemClock.now());
      // The command cannot see the cluster (only the process that serves holds its link to Redis), so where there is a Redis it
      // asks the operator to say that every node reads grants before it takes anything away.
      const needsWord =
        config.REDIS_URL !== undefined &&
        !clusterReady &&
        plan.writes.some((write) => restricts(write, catalogue.mode));
      if (plan.problems.length > 0) {
        fail(plan.problems.join('\n'));
      } else if (needsWord) {
        fail(
          'this server is clustered (REDIS_URL) and the file takes grants away: once every node runs a release that reads workspace grants, say so with --cluster-ready',
          1,
        );
      } else {
        if (clusterReady && !dryRun) {
          log.warn(
            '--cluster-ready is the operator’s word that every node reads workspace grants; nothing has checked it, and it is recorded with each change',
            { see: 'DEPLOY.md, entitlements:apply' },
          );
        }
        const changes = await applyEdition(
          database,
          systemClock,
          catalogue,
          `file:${basename(path)}`,
          plan.writes,
          dryRun,
          clusterReady,
        );
        // The file names workspaces by the address a tenant chose, and a tenant who registered it first is the workspace it finds. A dry
        // run says what each address resolved to, so the operator reads it against their own list of customers before the real one.
        if (dryRun) {
          for (const [slug, id] of [...resolved].sort())
            process.stdout.write(`workspace ${slug} = ${id}\n`);
        }
        const counts = new Map<string, number>();
        for (const change of changes)
          counts.set(
            `${change.module} ${change.state}`,
            (counts.get(`${change.module} ${change.state}`) ?? 0) + 1,
          );
        process.stdout.write(
          `${dryRun ? 'would change' : 'changed'} ${String(changes.length)} of ${String(plan.writes.length)} grants\n`,
        );
        for (const [what, count] of [...counts].sort())
          process.stdout.write(`  ${what}: ${String(count)}\n`);
      }
    }
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    fail(error.body.message, 2);
  } finally {
    await database.destroy();
  }
}
