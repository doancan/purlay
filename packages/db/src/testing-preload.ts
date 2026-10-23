/**
 * Run by `bun test` before the first test, from `bunfig.toml`: builds the cloned
 * databases' template where no hook timer is running (see `buildIntegrationTemplate`), and
 * brings the configured database itself up to date (`migrateIntegrationDatabase`).
 */
import {
  migrateIntegrationDatabase,
  prepareIntegrationTemplate,
  prepareTemplateForRun,
} from './testing';

// The template the clones come from, and the database `withRollback` uses itself: both current.
await prepareTemplateForRun(async () => {
  await prepareIntegrationTemplate();
  await migrateIntegrationDatabase();
}, process.stderr.write.bind(process.stderr));
