/**
 * A fact between modules that are not chat or issues, for the tests of the outbox (D-288): `notes` publishes `notes.created`
 * and `notes.pinned`, `wiki` consumes both and `shelf` consumes the first, each as a manifest and nothing more, since what is tested is the table, the claim and the delivery.
 */
import type { Executor } from '@purlay/db';
import { Type } from '@sinclair/typebox';
import { defineFact } from '@purlay/types';
import {
  effectiveModules,
  type EntitlementMode,
  type EntitlementPolicy,
} from '../platform/module-kit/entitlement';
import type { ModuleManifest } from '../platform/module-kit/manifest';
import { createMetricsRegistry } from '../platform/metrics';
import { factRoutingOf, type FactPublishContext } from '../platform/outbox';
import type { Clock } from '../platform/clock';
import { aUniqueSlug } from './users';

export const NOTE_CREATED = defineFact({
  type: 'notes.created',
  owner: 'notes',
  absent: 'drop',
  schema: Type.Object({
    noteId: Type.String({ maxLength: 36 }),
    title: Type.String({ maxLength: 9000 }),
  }),
});

export const NOTE_PINNED = defineFact({
  type: 'notes.pinned',
  owner: 'notes',
  absent: { holdDays: 3 },
  schema: Type.Object({ noteId: Type.String({ maxLength: 36 }) }),
});

/** `notes.created` as a newer release writes it: one more required field, which an older node's declaration refuses. */
export const NOTE_CREATED_V2 = defineFact({
  type: 'notes.created',
  owner: 'notes',
  absent: 'drop',
  shape: 2,
  schema: Type.Object({
    noteId: Type.String({ maxLength: 36 }),
    title: Type.String({ maxLength: 9000 }),
    folder: Type.String({ maxLength: 64 }),
  }),
});

const base = {
  requires: [],
  optional: [],
  degrades: {},
  provides: [],
  budget: { none: 'a test module' },
};

export const NOTES: ModuleManifest = {
  ...base,
  id: 'notes',
  publishes: ['notes.created', 'notes.pinned'],
};
export const WIKI: ModuleManifest = {
  ...base,
  id: 'wiki',
  optional: ['notes'],
  degrades: { notes: 'it shows nothing of the notes' },
  consumes: ['notes.created', 'notes.pinned'],
};

const SHELF: ModuleManifest = {
  ...base,
  id: 'shelf',
  optional: ['notes'],
  degrades: { notes: 'it shelves nothing of the notes' },
  consumes: ['notes.created'],
};

/**
 * What a publish is given: the build carries both modules, `running` says which this process runs, and `droppedCount` reads the
 * counter of the facts that were not written because their consumer is off.
 */
export const aPublishWorld = (
  workspaceId: string,
  clock: Clock,
  running: readonly ModuleManifest[] = [NOTES, WIKI, SHELF],
  producer = 'notes',
): { readonly context: FactPublishContext; readonly droppedCount: (module: string) => number } => {
  const registry = createMetricsRegistry();
  const dropped = registry.counter('test_dropped_total', 'dropped', ['module', 'fact']);
  return {
    context: {
      workspaceId,
      clock,
      producer,
      routing: factRoutingOf([NOTES, WIKI, SHELF], running),
      dropped,
    },
    droppedCount: (module) =>
      registry
        .families()
        .flatMap((family) => family.samples)
        .find((sample) => sample.labels['module'] === module)?.value ?? 0,
  };
};

export const aWorkspaceRow = async (executor: Executor): Promise<string> => {
  const slug = aUniqueSlug('outbox');
  const row = await executor
    .insertInto('workspaces')
    .values({ name: slug, slug })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/** The composition's function of workspace grants over the modules a process runs, with the server's mode (D-289). */
export const theGrants =
  (
    running: readonly ModuleManifest[] = [NOTES, WIKI, SHELF],
    mode: EntitlementMode = 'open',
  ): EntitlementPolicy['effective'] =>
  (rows, now) =>
    effectiveModules({ running, rows, mode, now });

/** The operator's word for one workspace and one module, as a row of `workspace_modules`. */
export const aGrant = async (
  executor: Executor,
  workspaceId: string,
  module: string,
  state: 'on' | 'off',
  validUntil: Date | null = null,
): Promise<void> => {
  await executor
    .insertInto('workspace_modules')
    .values({
      workspace_id: workspaceId,
      module,
      state,
      valid_until: validUntil,
      source: 'test',
      changed_at: new Date(0),
    })
    .execute();
};
