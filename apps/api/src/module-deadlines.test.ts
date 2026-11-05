/**
 * Every module has a deadline for its requests or a reason it has none, and that reason is a line a reviewer sees
 * (`MODULES.md` §7, D-270): a module that declares `deadline: { none }` cannot be added without editing this list. A module
 * that says nothing has the platform's default.
 */
import { describe, expect, test } from 'bun:test';
import { bundledModules } from './composition';
import type { ModuleManifest } from './platform/module-kit/manifest';
import { DEFAULT_DEADLINE_MS } from './platform/request-deadline';

const manifests: readonly ModuleManifest[] = bundledModules.map(({ manifest }) => manifest);

/** The modules that declare `deadline: { none }`, with what they say; empty while every request of a module is bounded. */
const WITHOUT_A_DEADLINE: Readonly<Record<string, string>> = {};

describe('the modules whose requests have no deadline', () => {
  test('are exactly the ones listed here, each with the reason its manifest gives', () => {
    const declared = Object.fromEntries(
      manifests.flatMap((manifest) =>
        manifest.deadline !== undefined && 'none' in manifest.deadline
          ? [[manifest.id, manifest.deadline.none]]
          : [],
      ),
    );
    expect(declared).toEqual(WITHOUT_A_DEADLINE);
    for (const reason of Object.values(WITHOUT_A_DEADLINE)) expect(reason.trim()).not.toBe('');
  });

  test('every other module waits longer than its own queue for a connection, and none longer than the default', () => {
    for (const { deadline, budget } of manifests) {
      if (deadline !== undefined && 'none' in deadline) continue;
      const ms = deadline?.ms ?? DEFAULT_DEADLINE_MS;
      if ('poolShare' in budget) expect(ms).toBeGreaterThan(budget.poolShare(10).queueTimeoutMs);
      expect(ms).toBeLessThanOrEqual(DEFAULT_DEADLINE_MS);
    }
  });
});
