/**
 * The pool's arithmetic for many modules (D-281, D-266), written in `docs/DEPLOY.md` and held here.
 *
 * A share is a cap, not a reservation, so the shares may add up to more than the pool; what the pool does promise is
 * that no module is left without a connection. That holds while every module can have one at the same time, which
 * is `modulesPool(poolMax)` of them. Past that the module that arrives last waits behind the others, so a platform
 * with more modules than that needs a larger `DATABASE_POOL_MAX`, and this fails first (#1304).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { bundledModules } from './composition';
import { DATABASE_POOL_MAX_DEFAULT } from './platform/config';
import { modulesPool } from './platform/module-budget';

/** The platform this arithmetic is written for: the module count the issue asks to be sized for. */
const PLATFORM_MODULES = 25;

const smallestPoolFor = (modules: number): number => {
  let poolMax = 1;
  while (modulesPool(poolMax) < modules) poolMax += 1;
  return poolMax;
};

describe('the pool, and the modules that share it', () => {
  test('every bundled module can hold a connection at once in the default pool', () => {
    expect(bundledModules.length).toBeLessThanOrEqual(modulesPool(DATABASE_POOL_MAX_DEFAULT));
  });

  test('no module is given a share larger than what the modules may take together', () => {
    for (const poolMax of [1, 2, 3, 5, 10, 31, 100]) {
      for (const { manifest } of bundledModules) {
        if (!('poolShare' in manifest.budget)) continue;
        const { maxConcurrent } = manifest.budget.poolShare(poolMax);
        expect({
          poolMax,
          module: manifest.id,
          fits: maxConcurrent <= modulesPool(poolMax),
        }).toEqual({
          poolMax,
          module: manifest.id,
          fits: true,
        });
      }
    }
  });

  test('the pool is the modules plus the core: the core keeps a fifth, and a pool of one keeps none', () => {
    expect([1, 2, 5, 10, 31].map(modulesPool)).toEqual([1, 1, 4, 8, 25]);
  });

  test('DEPLOY.md states the smallest pool for the platform of 25 modules, and it is the one this computes', () => {
    const deploy = readFileSync('docs/DEPLOY.md', 'utf8').replace(/\s+/g, ' ');
    const poolMax = smallestPoolFor(PLATFORM_MODULES);
    expect(poolMax).toBe(31);
    expect(deploy).toContain(
      `${String(PLATFORM_MODULES)} modules need \`DATABASE_POOL_MAX\` of at least ${String(poolMax)}`,
    );
    expect(deploy).toContain(`${String(modulesPool(DATABASE_POOL_MAX_DEFAULT))} modules`);
  });
});
