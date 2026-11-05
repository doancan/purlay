/**
 * The core's claims (`platform/module-kit/core-claims.ts`) are held to the code that answers them, so that the overlap check of a bundle
 * (`registry.ts`) compares a module with what the core really has, and a claim the core takes later is not missed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { AUDIT_ACTIONS, ClientFrame, ServerFrame } from '@purlay/types';
import { bundledModules, composition, type BundledModule } from './composition';
import { PLAN } from './modules/jobs/schedule';
import {
  CORE_CLAIMS,
  CORE_EVENTS,
  CORE_FRAMES,
  CORE_JOBS,
  CORE_ROUTES,
} from './platform/module-kit/core-claims';
import { CORE_PERMISSIONS } from './platform/module-kit/permissions';
import { ModuleConfigError, moduleRegistry } from './platform/module-kit/registry';

const sorted = (names: Iterable<string>): string[] => [...names].sort();
const carried: readonly BundledModule[] = bundledModules;
const owned = (kind: 'jobs' | 'frames' | 'events'): string[] =>
  carried.flatMap((module) => module.manifest[kind] ?? []);
/** A module's retention jobs are jobs too: `bun run job` is asked for them by name. */
const ownedJobs = (): string[] => [
  ...owned('jobs'),
  ...carried.flatMap((module) => module.manifest.retention ?? []),
];

describe('what the core claims', () => {
  test('every socket operation a client may send is the core’s or exactly one module’s', () => {
    const sent = ClientFrame.anyOf.map((frame) => frame.properties.op.const);
    expect(sorted([...CORE_FRAMES, ...owned('frames')])).toEqual(sorted(sent));
  });

  test('every server event is the core’s or exactly one module’s', () => {
    const sent = new Set(ServerFrame.anyOf.map((frame) => frame.properties.event.const));
    expect(sorted([...CORE_EVENTS, ...owned('events')])).toEqual(sorted(sent));
  });

  test('every audit action the wire names is the core’s or exactly one module’s', () => {
    const declared = carried.flatMap((module) =>
      (module.manifest.auditActions ?? []).flatMap((group) => group.actions),
    );
    expect(sorted([...CORE_CLAIMS.auditActions, ...declared])).toEqual(sorted(AUDIT_ACTIONS));
  });

  test('every permission a module declares is read by the registry as its own', () => {
    for (const { manifest } of carried) {
      for (const { name } of manifest.permissions ?? [])
        expect(name.startsWith(`${manifest.id}.`)).toBe(true);
    }
  });

  test('the core claims the permissions it declares', () => {
    expect(CORE_CLAIMS.permissions).toEqual(CORE_PERMISSIONS.map((declared) => declared.name));
  });

  test('every scheduled job, and every job the command runs, is the core’s or exactly one module’s', () => {
    expect(sorted([...CORE_JOBS, ...ownedJobs()])).toEqual(sorted(PLAN.map((slot) => slot.job)));
    // The command lists the core's jobs and takes a module's from the composition, so what it lists is the core's alone.
    const text = readFileSync(join(import.meta.dir, 'cli/jobs.ts'), 'utf8');
    const listed = [...text.matchAll(/^ {2}'([a-z]+:[a-z-]+)': /gm)].map((match) => match[1] ?? '');
    expect(sorted(listed)).toEqual(sorted(CORE_JOBS));
    expect(sorted(Object.keys(composition.jobWork))).toEqual(sorted(ownedJobs()));
  });

  test('the socket upgrade is the core’s', () => {
    expect(CORE_ROUTES).toContain('/ws');
  });

  test.each(['/auth/x', '/auth/x/y', '/ws'])(
    'a module that claims %s, which the core answers, is refused',
    (route) => {
      const manifest = {
        id: 'notes',
        requires: [],
        optional: [],
        provides: [],
        budget: { none: 'a test module' },
        routes: [route],
      };
      let refused: readonly string[] = [];
      try {
        moduleRegistry([manifest], CORE_CLAIMS);
      } catch (error) {
        if (!(error instanceof ModuleConfigError)) throw error;
        refused = error.problems;
      }
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(`"notes" owns the route "${route}"`);
    },
  );
});
