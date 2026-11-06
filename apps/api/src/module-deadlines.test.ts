/**
 * Every module has a deadline for its requests or a reason it has none, and that reason is a line a reviewer sees
 * (`MODULES.md` §7, D-270): a module that declares `deadline: { none }` cannot be added without editing this list. A module
 * that says nothing has the platform's default.
 */
import { describe, expect, test } from 'bun:test';
import { bundledModules } from './composition';
import type { ModuleManifest } from './platform/module-kit/manifest';
import { DEFAULT_JOB_DEADLINE_MS } from './modules/jobs/module-shares';
import { DEFAULT_WORKER_DEADLINE_MS } from './modules/workers/module-workers';
import { DEFAULT_DEADLINE_MS } from './platform/request-deadline';

const manifests: readonly ModuleManifest[] = bundledModules.map(({ manifest }) => manifest);

/** The modules that declare `deadline: { none }`, with what they say; empty while every request of a module is bounded. */
const WITHOUT_A_DEADLINE: Readonly<Record<string, string>> = {};

/**
 * The modules that declare `jobDeadline: { none }`, with what they say (D-274); empty while every run of a module's scheduled
 * jobs is bounded.
 */
const WITHOUT_A_JOB_DEADLINE: Readonly<Record<string, string>> = {};

/**
 * The modules that declare `workerDeadline: { none }`, with what they say; empty while every iteration of a module's
 * background loops is bounded.
 */
const WITHOUT_A_WORKER_DEADLINE: Readonly<Record<string, string>> = {};

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

describe('the modules whose scheduled jobs have no deadline', () => {
  test('are exactly the ones listed here, each with the reason its manifest gives', () => {
    const declared = Object.fromEntries(
      manifests.flatMap((manifest) =>
        manifest.jobDeadline !== undefined && 'none' in manifest.jobDeadline
          ? [[manifest.id, manifest.jobDeadline.none]]
          : [],
      ),
    );
    expect(declared).toEqual(WITHOUT_A_JOB_DEADLINE);
    for (const reason of Object.values(WITHOUT_A_JOB_DEADLINE)) expect(reason.trim()).not.toBe('');
  });

  test('every other module’s jobs are cut off after a time that is a number and no longer than the default', () => {
    for (const { jobDeadline } of manifests) {
      if (jobDeadline !== undefined && 'none' in jobDeadline) continue;
      const ms = jobDeadline?.ms ?? DEFAULT_JOB_DEADLINE_MS;
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeLessThanOrEqual(DEFAULT_JOB_DEADLINE_MS);
    }
  });
});

describe('the modules whose background loops have no deadline', () => {
  test('are exactly the ones listed here, each with the reason its manifest gives', () => {
    const declared = Object.fromEntries(
      manifests.flatMap((manifest) =>
        manifest.workerDeadline !== undefined && 'none' in manifest.workerDeadline
          ? [[manifest.id, manifest.workerDeadline.none]]
          : [],
      ),
    );
    expect(declared).toEqual(WITHOUT_A_WORKER_DEADLINE);
    for (const reason of Object.values(WITHOUT_A_WORKER_DEADLINE))
      expect(reason.trim()).not.toBe('');
  });

  test('every other module’s iterations are cut off after a whole number of milliseconds no longer than the default', () => {
    for (const { workerDeadline } of manifests) {
      if (workerDeadline !== undefined && 'none' in workerDeadline) continue;
      const ms = workerDeadline?.ms ?? DEFAULT_WORKER_DEADLINE_MS;
      expect(Number.isInteger(ms)).toBe(true);
      expect(ms).toBeLessThanOrEqual(DEFAULT_WORKER_DEADLINE_MS);
    }
  });
});
