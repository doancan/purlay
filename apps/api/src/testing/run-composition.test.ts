import { describe, expect, test } from 'bun:test';
import { bundledModules } from '../composition';
import { testDependencies } from './doubles';
import { moduleCells } from './module-cells';
import { runComposition } from './run-composition';

/** What a process started with this `MODULES` composes for a test, asked of a process of its own: the setting is read at start. */
const modulesRunBy = (setting: string | undefined): string[] => {
  const environment = { ...process.env };
  delete environment['MODULES'];
  if (setting !== undefined) environment['MODULES'] = setting;
  const probe = [
    `import { testDependencies } from ${JSON.stringify(`${import.meta.dir}/doubles`)};`,
    'console.log(JSON.stringify(testDependencies().composition.modules.map((m) => m.manifest.id)));',
  ].join('\n');
  const run = Bun.spawnSync([process.execPath, '--no-env-file', '-e', probe], {
    env: environment,
    stderr: 'pipe',
  });
  expect({ code: run.exitCode, said: run.stderr.toString() }).toEqual({ code: 0, said: '' });
  return JSON.parse(run.stdout.toString()) as string[];
};

describe('the application a test builds', () => {
  test('is composed of the run’s modules', () => {
    expect(testDependencies().composition).toBe(runComposition);
  });

  test('runs the modules the run’s MODULES names, whichever cell that is, and every module when it is unset', () => {
    expect(modulesRunBy(undefined)).toEqual(bundledModules.map((module) => module.manifest.id));
    for (const cell of moduleCells(bundledModules)) {
      expect(modulesRunBy(cell.setting)).toEqual([...cell.ids]);
    }
  });
});
