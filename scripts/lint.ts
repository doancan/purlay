/** The CLI entry; selection, execution and argument policy are tested in lint-runner. */
import { resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { lintMain } from './lint-runner';

process.exitCode = lintMain(
  resolve(import.meta.dirname, '..'),
  packageJson.workspaces,
  Bun.argv.slice(2),
);
