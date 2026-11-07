/**
 * `bun run modules:cells`: the legs of CI's `module-suites` matrix as a JSON array of `MODULES` values, made from the modules the
 * build carries, so the workflow lists no module (`ci.yml` reads it with `fromJSON`; `module-suites.test.ts` holds the two together).
 */
import { appendFileSync } from 'node:fs';
import { bundledModules } from '../composition';
import { moduleCells } from './module-cells';
import { cellsToRun } from './module-suites';

export const matrixSettings = (): string[] =>
  cellsToRun(
    bundledModules.map(({ manifest }) => manifest.id),
    moduleCells(bundledModules),
  ).flatMap((cell) => cell.setting ?? []);

if (import.meta.main) {
  const matrix = JSON.stringify(matrixSettings());
  // CI reads it from the step's output file; a developer reads it from the terminal.
  const output = process.env['GITHUB_OUTPUT'];
  if (Bun.argv.includes('--github-output') && output !== undefined) {
    appendFileSync(output, `matrix=${matrix}\n`);
  } else {
    process.stdout.write(`${matrix}\n`);
  }
}
