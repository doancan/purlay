/**
 * Run by `bun test` before the first test, from `bunfig.toml`: builds the cloned
 * databases' template where no hook timer is running (see `buildIntegrationTemplate`).
 */
import { prepareIntegrationTemplate, prepareTemplateForRun } from './testing';

await prepareTemplateForRun(prepareIntegrationTemplate, process.stderr.write.bind(process.stderr));
