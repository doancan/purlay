/**
 * A module's manifest declares the permissions it asks (`permissions`), and the core reads that list: who holds what, and
 * nothing of a module that is not run. This holds the list to the code in both directions, as `module-emissions.test.ts`
 * does for events: a module that asks a permission its manifest does not declare would be answered no by nobody's rules,
 * and one that declares a name its source no longer writes is promising a rule that is gone.
 *
 * It scans the production source for a permission written as a string at a call of `holds(role, '…')`. A name held in a
 * constant is not seen by it; the constant a manifest declares is the same one the service asks, so the two cannot
 * differ, and a constant that is declared and no longer written in the module's source is what the last check finds.
 */
import { describe, expect, test } from 'bun:test';
import { bundledModules, type BundledModule } from './composition';
import { CORE_CLAIMS } from './platform/module-kit/core-claims';
import { coreSources, sourcesOf, textOf } from './testing/module-sources';

const carried: readonly BundledModule[] = bundledModules;
const IDS = carried.map((module) => module.manifest.id);

/** The permission written as a string at a call of `holds`. */
const heldIn = (text: string): string[] =>
  [...text.matchAll(/\bholds\(\s*[^,()]+,\s*'([^']+)'/g)].map((match) => match[1] ?? '');

describe('what the sweep sees', () => {
  test('finds a permission asked by name, and not one held in a constant', () => {
    expect(heldIn("permissions.holds(context.role, 'issues.delete-any')")).toEqual([
      'issues.delete-any',
    ]);
    expect(heldIn('permissions.holds(context.role, ISSUES_DELETE_ANY)')).toEqual([]);
  });
});

describe('the permissions a module asks are the ones it declares', () => {
  test.each(carried.map((module) => [module.manifest.id, module] as const))(
    '%s asks only what it or the core declares, and writes every name it declares',
    (id, module) => {
      const own = (module.manifest.permissions ?? []).map((declared) => declared.name);
      const allowed = [...own, ...CORE_CLAIMS.permissions];
      const text = textOf(sourcesOf(id));
      expect(heldIn(text).filter((name) => !allowed.includes(name))).toEqual([]);
      expect(own.filter((name) => !text.includes(`'${name}'`))).toEqual([]);
    },
  );

  test('the core asks only what it declares, and none of a module’s', () => {
    const asked = heldIn(textOf(coreSources(IDS)));
    expect(asked.filter((name) => !CORE_CLAIMS.permissions.includes(name))).toEqual([]);
  });
});
