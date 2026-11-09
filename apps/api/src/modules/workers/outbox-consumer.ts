/**
 * The worker that delivers the facts a module consumes (`MODULES.md` §4, D-288 §8): one for each module that has handlers, named
 * `outbox:consume`, made by the composition and not written by the module. It is a worker like any other (D-281): it takes the
 * module's share of the pool, runs under the module's `workerDeadline`, and a throw is counted in
 * `purlay_worker_failures_total{module,worker}` and left for the next interval. The module supplies the handlers; it does not
 * claim a row, lock one or mark one.
 */
import { FACT_SHAPE_FIRST, type FactDeclaration } from '@purlay/types';
import type { FactConsumers } from '../../platform/fact-consumers';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { drainOnce, type Handled, type FactHandling } from '../../platform/outbox-drain';
import type { ModuleWorker } from './module-workers';

const OUTBOX_CONSUME_WORKER = 'outbox:consume';

/** Between the end of one drain and the start of the next: a fact waits this and the time of the work (measured, D-288 §8). */
export const OUTBOX_CONSUME_INTERVAL_MS = 2_000;

/** Rows a drain takes: the handlers run one after another, and a module's deadline bounds the whole. */
const OUTBOX_CONSUME_BATCH = 20;

/** The workers a module's handlers need: none without handlers, else the one that delivers. */
export const outboxConsumerWorkers = (
  module: string,
  factConsumers: FactConsumers | undefined,
  facts: readonly FactDeclaration[],
  effective?: EntitlementPolicy['effective'],
): readonly ModuleWorker[] => {
  const types = Object.keys(factConsumers ?? {});
  if (factConsumers === undefined || types.length === 0) return [];
  const handlers = types.map((type): Handled & FactHandling => {
    const declaration = facts.find((fact) => fact.type === type);
    const handle = factConsumers[type];
    if (declaration === undefined || handle === undefined) {
      throw new Error(
        `"${module}" has a handler for the fact "${type}", which no declaration describes`,
      );
    }
    return {
      consumer: module,
      type,
      shape: declaration.shape ?? FACT_SHAPE_FIRST,
      declaration,
      handle,
    };
  });
  return [
    {
      name: OUTBOX_CONSUME_WORKER,
      intervalMs: OUTBOX_CONSUME_INTERVAL_MS,
      work: async ({ database, clock, log, outbox, ports, seams }): Promise<void> => {
        await drainOnce(database, {
          handlers,
          batch: OUTBOX_CONSUME_BATCH,
          clock,
          log,
          ports,
          seams,
          ...(effective === undefined ? {} : { effective }),
          ...(outbox === undefined ? {} : { counters: outbox }),
        });
      },
    },
  ];
};
