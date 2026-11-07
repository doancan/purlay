/**
 * Every optional edge of the build runs its module's scenario with the partner left out (D-291, `testing/degradation.ts`).
 * A module's scenarios are `features/<id>/degradation.testing.ts`, found by the folder, so a module added lists nothing here.
 */
import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { bundledModules } from './composition';
import {
  degradationCases,
  degradationGaps,
  type DegradationScenario,
  type Scenarios,
} from './testing/degradation';

const SCENARIO_FILES = new Glob('features/*/degradation.testing.ts');

const loadScenarios = async (): Promise<Scenarios> => {
  const scenarios: Record<string, Record<string, DegradationScenario>> = {};
  for (const file of SCENARIO_FILES.scanSync({ cwd: import.meta.dir })) {
    const module = file.split('/')[1] ?? '';
    const loaded = (await import(`./${file}`)) as {
      degradation: Record<string, DegradationScenario>;
    };
    scenarios[module] = loaded.degradation;
  }
  return scenarios;
};

const scenarios = await loadScenarios();

describe('a module that uses a partner when it is there', () => {
  test('has a scenario for each optional partner and none for another', () => {
    expect(degradationGaps(bundledModules, scenarios)).toEqual([]);
  });

  for (const { name, run } of degradationCases(bundledModules, scenarios)) test(name, run);
});
