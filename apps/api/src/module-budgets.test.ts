/**
 * Every module has a share of the connection pool or a reason it has none, and that reason is a line a reviewer sees
 * (`MODULES.md` §7, D-260, D-266). A manifest that says `none` cannot be added without editing this list, which is the
 * point: the choice not to budget a module is somebody's decision, written here beside the module's name.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { bundledModules } from './composition';

/** The modules that declare `budget: { none }`, with what they say; empty while every module has a share. */
const EXEMPT_FROM_A_SHARE: Readonly<Record<string, string>> = {};

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

/** Where a module's pool-share integration test is, unless it is in `POOL_SHARE_TESTS_ELSEWHERE`. */
const poolShareTestOf = (id: string): string => `features/${id}/http/budget.integration.test.ts`;

/**
 * Pool-share tests that are not in their module's folder, with where they are: chat's handlers were in `ingress/` when
 * its test was written and it has not moved. A module added later puts its test at `poolShareTestOf`; an entry here whose
 * module has its test there fails, so the list only shrinks.
 */
const POOL_SHARE_TESTS_ELSEWHERE: Readonly<Record<string, string>> = {
  chat: 'ingress/http/chat-budget.integration.test.ts',
};

describe('every module with a share of the pool has a test that fills it', () => {
  const sharing = bundledModules
    .map(({ manifest }) => manifest)
    .filter((manifest) => 'poolShare' in manifest.budget)
    .map(({ id }) => id);

  const testOf = (id: string): string => POOL_SHARE_TESTS_ELSEWHERE[id] ?? poolShareTestOf(id);

  test('the test is where the convention or the table says, and says it needs the module', () => {
    for (const id of sharing) {
      const path = join(import.meta.dir, testOf(id));
      const exists = existsSync(path);
      const needs =
        exists && new RegExp(`@needs-modules[^\\n]*\\b${id}\\b`).test(readFileSync(path, 'utf8'));
      expect({ id, path: testOf(id), exists, needs }).toEqual({
        id,
        path: testOf(id),
        exists: true,
        needs: true,
      });
    }
  });

  test('the table names only modules that have a share and whose test is not in its folder', () => {
    for (const [id, path] of Object.entries(POOL_SHARE_TESTS_ELSEWHERE)) {
      expect({ id, shares: sharing.includes(id) }).toEqual({ id, shares: true });
      expect({
        id,
        path,
        inItsFolder: existsSync(join(import.meta.dir, poolShareTestOf(id))),
      }).toEqual({
        id,
        path,
        inItsFolder: false,
      });
    }
  });
});
