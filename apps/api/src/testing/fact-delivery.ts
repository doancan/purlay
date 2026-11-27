/**
 * A fact published and delivered for a module's own integration test (`MODULE-GUIDE.md` §5, D-353): the module's real slot, composed
 * as a process composes it, publishing through the publisher a route is handed and delivering through the `outbox:consume` worker the
 * composition makes, against a real database. What `testing/facts.ts` builds by hand for the outbox's own tests, for a module that has
 * a fact and a consumer and wants to see its handler run.
 */
import type { Static } from '@sinclair/typebox';
import type { Executor } from '@purlay/db';
import type { FactDeclaration } from '@purlay/types';
import type { Composition } from '../composition';
import { factContextOf, seamsOfModules } from '../module-seams-wiring';
import { OUTBOX_CONSUME_WORKER } from '../modules/workers/outbox-consumer';
import { systemClock, type Clock } from '../platform/clock';
import { NO_LOG } from '../platform/events';
import { inProcessEventBus } from '../realtime/bus';
import type { Logger } from '../platform/logging';
import { serverMetrics } from '../platform/metrics';
import { publishFact } from '../platform/outbox';
import { inWorkspace } from '../platform/ports/module-seams';
import { atomicallyOn } from '../platform/transactions';
import { OUTBOX_PENDING_MAX_DEFAULT } from '../platform/config';
import { aRecordingLogger } from './doubles';

/** What a test's publish and delivery are handed: an in-process bus, a registry of its own and the outbox's default limits. */
const seamInputsOf = (
  composition: Composition,
  clock: Clock,
  log: Logger,
): Parameters<typeof seamsOfModules>[0] => ({
  composition,
  clock,
  bus: inProcessEventBus(() => undefined, NO_LOG),
  log,
  metrics: serverMetrics(),
  outboxPendingMax: OUTBOX_PENDING_MAX_DEFAULT,
  deliveriesPerMinuteMax: null,
});

/**
 * Runs one iteration of the `outbox:consume` worker of every module the composition runs, as a process's scheduler would: for a test
 * whose fact was published by the real path (a route, the core) rather than by `publishAndDeliver`.
 */
export const deliverPending = async (
  database: Executor,
  composition: Composition,
  input: { readonly clock?: Clock; readonly log?: Logger } = {},
): Promise<void> => {
  const { clock = systemClock, log = aRecordingLogger().log } = input;
  const inputs = seamInputsOf(composition, clock, log);
  const seamsOf = seamsOfModules(inputs);
  for (const worker of composition.workers.filter(({ name }) => name === OUTBOX_CONSUME_WORKER)) {
    const seams = seamsOf(worker.module);
    await worker.work({
      database,
      clock,
      log,
      bus: inputs.bus,
      ports: composition.portsFor(worker.module, database),
      seams,
      inWorkspace: async (turn, work) => await inWorkspace(seams, database, turn, work),
      entitled: composition.entitledFor(worker.module, database),
    });
  }
};

/** What became of each consumer's delivery of the fact: `pending` (failed, or not run here), `delivered`, `skipped` or `dead`. */
export type DeliveredTo = Readonly<Record<string, string>>;

/**
 * Publishes `fact` as its owner in `workspaceId`, in a transaction that commits, then runs one iteration of the `outbox:consume`
 * worker of every module the composition runs, and says what became of the fact for each consumer that got a row. A consumer the
 * workspace is not granted gets none (D-353), and one that is not run is left `pending`. A handler that throws leaves its row
 * `pending` for its backoff: the test sees it, and the clock it moves decides when the next call delivers it.
 */
export const publishAndDeliver = async <Fact extends FactDeclaration>(
  database: Executor,
  composition: Composition,
  input: {
    readonly workspaceId: string;
    readonly fact: Fact;
    readonly payload: Static<Fact['schema']>;
    readonly clock?: Clock;
    readonly log?: Logger;
  },
): Promise<DeliveredTo> => {
  const { workspaceId, fact, payload, clock = systemClock, log = aRecordingLogger().log } = input;
  const inputs = seamInputsOf(composition, clock, log);
  const before = new Set(
    (
      await database
        .selectFrom('outbox')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .where('type', '=', fact.type)
        .execute()
    ).map(({ id }) => id),
  );
  await atomicallyOn(database)(async (transaction) => {
    await publishFact(
      transaction,
      { ...factContextOf(inputs), workspaceId, producer: fact.owner },
      fact,
      payload,
    );
  });
  await deliverPending(database, composition, { clock, log });
  const rows = await database
    .selectFrom('outbox')
    .select(['id', 'consumer', 'state'])
    .where('workspace_id', '=', workspaceId)
    .where('type', '=', fact.type)
    .execute();
  return Object.fromEntries(
    rows.filter(({ id }) => !before.has(id)).map(({ consumer, state }) => [consumer, state]),
  );
};
