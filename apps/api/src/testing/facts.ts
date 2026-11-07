/**
 * A fact between modules that are not chat or issues, for the tests of the outbox (D-288): `notes` publishes `notes.created`
 * and `notes.pinned`, `wiki` consumes both and `shelf` consumes the first, each as a manifest and nothing more, since what is tested is the table, the claim and the delivery.
 */
import type { Executor } from '@purlay/db';
import { Type } from '@sinclair/typebox';
import { defineFact } from '@purlay/types';
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

const base = { requires: [], optional: [], provides: [], budget: { none: 'a test module' } };

export const NOTES: ModuleManifest = {
  ...base,
  id: 'notes',
  publishes: ['notes.created', 'notes.pinned'],
};
export const WIKI: ModuleManifest = {
  ...base,
  id: 'wiki',
  optional: ['notes'],
  consumes: ['notes.created', 'notes.pinned'],
};

const SHELF: ModuleManifest = {
  ...base,
  id: 'shelf',
  optional: ['notes'],
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
