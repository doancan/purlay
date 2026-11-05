/**
 * Every route the application registers belongs to the core or to a module, and says which (D-250, `MODULES.md` §3).
 *
 * A module that is not run has no route: its paths are the `404` of any unknown one. That holds only for the paths its
 * manifest lists, so a route added to `app.ts` that nobody classified would stay mounted with the module off. This reads the
 * paths `app.ts` registers and holds each to exactly one owner: the core's list below or a manifest's templates. A new
 * route fails here until it is put in one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundledModules, type BundledModule } from '../../composition';
import { CORE_ROUTES } from '../../platform/module-kit/core-claims';
import { ownsPath } from '../../platform/module-kit/routes';

const registered = (): string[] => {
  const text = readFileSync(join(import.meta.dir, 'app.ts'), 'utf8');
  return [
    ...new Set(
      [...text.matchAll(/\.(?:get|post|put|patch|delete|ws)\(\s*'(\/[^']*)'/g)].map(
        (m) => m[1] ?? '',
      ),
    ),
  ].sort();
};

const carried: readonly BundledModule[] = bundledModules;

describe('who owns each route', () => {
  const owners = carried.map((module) => ({
    id: module.manifest.id,
    owns: ownsPath(module.manifest.routes ?? []),
  }));

  test('every route the application registers is the core’s or exactly one module’s', () => {
    const unowned: string[] = [];
    const twice: string[] = [];
    for (const path of registered()) {
      const by = [
        ...(CORE_ROUTES.includes(path) ? ['core'] : []),
        ...owners.filter((owner) => owner.owns(path)).map((owner) => owner.id),
      ];
      if (by.length === 0) unowned.push(path);
      if (by.length > 1) twice.push(`${path}: ${by.join(', ')}`);
    }
    expect({ unowned, twice }).toEqual({ unowned: [], twice: [] });
  });

  test('the core’s list holds no route that is gone, and no module’s template matches nothing', () => {
    const paths = registered();
    expect(CORE_ROUTES.filter((path) => !paths.includes(path))).toEqual([]);
    for (const module of carried) {
      const dead = (module.manifest.routes ?? []).filter((template) => {
        const owns = ownsPath([template]);
        return !paths.some((path) => owns(path));
      });
      expect({ module: module.manifest.id, dead }).toEqual({
        module: module.manifest.id,
        dead: [],
      });
    }
  });
});
