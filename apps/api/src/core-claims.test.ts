/**
 * The core's claims (`platform/module-kit/core-claims.ts`) are held to the code that answers them, so that the overlap check of a bundle
 * (`registry.ts`) compares a module with what the core really has, and a claim the core takes later is not missed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { ClientFrame, ServerFrame } from '@purlay/types';
import { bundledModules, type BundledModule } from './composition';
import { PLAN } from './modules/jobs/schedule';
import { CORE_EVENTS, CORE_FRAMES, CORE_JOBS } from './platform/module-kit/core-claims';

const sorted = (names: Iterable<string>): string[] => [...names].sort();
const carried: readonly BundledModule[] = bundledModules;
const owned = (kind: 'jobs' | 'frames' | 'events'): string[] =>
  carried.flatMap((module) => module.manifest[kind] ?? []);

describe('what the core claims', () => {
  test('every socket operation a client may send is the core’s or exactly one module’s', () => {
    const sent = ClientFrame.anyOf.map((frame) => frame.properties.op.const);
    expect(sorted([...CORE_FRAMES, ...owned('frames')])).toEqual(sorted(sent));
  });

  test('every server event is the core’s or exactly one module’s', () => {
    const sent = new Set(ServerFrame.anyOf.map((frame) => frame.properties.event.const));
    expect(sorted([...CORE_EVENTS, ...owned('events')])).toEqual(sorted(sent));
  });

  test('every scheduled job, and every job the command runs, is the core’s or exactly one module’s', () => {
    expect(sorted([...CORE_JOBS, ...owned('jobs')])).toEqual(sorted(PLAN.map((slot) => slot.job)));
    const text = readFileSync(join(import.meta.dir, 'cli/jobs.ts'), 'utf8');
    const runnable = [...text.matchAll(/^ {2}'([a-z]+:[a-z-]+)': /gm)].map(
      (match) => match[1] ?? '',
    );
    expect(sorted([...CORE_JOBS, ...owned('jobs')])).toEqual(sorted(runnable));
  });
});
