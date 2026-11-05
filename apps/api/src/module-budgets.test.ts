/**
 * Every module has a share of the connection pool or a reason it has none, and that reason is a line a reviewer sees
 * (`MODULES.md` §7, D-260, D-266). A manifest that says `none` cannot be added without editing this list, which is the
 * point: the choice not to budget a module is somebody's decision, written here beside the module's name.
 */
import { describe, expect, test } from 'bun:test';
import { bundledModules } from './composition';

/** The modules that declare `budget: { none }`, with what they say. */
const EXEMPT_FROM_A_SHARE: Readonly<Record<string, string>> = {
  chat: 'chat is what the other modules are kept from slowing, so it has no share of its own',
};

describe('the modules that have no share of the pool', () => {
  test('are exactly the ones listed here, each with the reason its manifest gives', () => {
    const declared = Object.fromEntries(
      bundledModules.flatMap(({ manifest }) =>
        'none' in manifest.budget ? [[manifest.id, manifest.budget.none]] : [],
      ),
    );
    expect(declared).toEqual(EXEMPT_FROM_A_SHARE);
    for (const reason of Object.values(EXEMPT_FROM_A_SHARE)) expect(reason.trim()).not.toBe('');
  });

  test('every other module has a share that is a whole number of connections in every pool', () => {
    for (const { manifest } of bundledModules) {
      if (!('poolShare' in manifest.budget)) continue;
      for (const poolMax of [1, 2, 10, 100]) {
        const { maxConcurrent, queueTimeoutMs, statementTimeoutMs } =
          manifest.budget.poolShare(poolMax);
        expect(Number.isInteger(maxConcurrent) && maxConcurrent >= 1).toBe(true);
        expect(queueTimeoutMs).toBeGreaterThan(0);
        expect(statementTimeoutMs).toBeGreaterThan(0);
      }
    }
  });
});
