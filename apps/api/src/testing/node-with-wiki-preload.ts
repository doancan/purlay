/**
 * Makes the build the process runs carry the fake `notes` and `wiki` of `testing/facts.ts`, so that the real entry point boots with
 * a consumer of facts (the bundled modules have none yet): `wiki` takes every `notes.created` and `notes.pinned` from the outbox and writes one row
 * to `cluster_deliveries`, in the transaction that marks the fact delivered, naming the node by `NODE_LABEL`. `HANDLER_PACE_MS`
 * is how long a delivery takes, so that a test has a run long enough to end a node in the middle of. Used as `bun --preload`
 * before `apps/api/src/index.ts`.
 */
import { sql } from '@purlay/db';
import { FACTS, MODULE_IDS } from '@purlay/types';
import { bundledModules, type BundledModule } from '../composition';
import type { FactConsumer } from '../platform/fact-consumers';
import { NOTE_CREATED, NOTE_PINNED, NOTES, WIKI } from './facts';

const label = process.env['NODE_LABEL'] ?? 'unnamed';
const pace = Number(process.env['HANDLER_PACE_MS'] ?? '0');

const deliver: FactConsumer = async (fact, transaction) => {
  await sql`insert into cluster_deliveries (fact_id, node) values (${fact.factId}, ${label})`.execute(
    transaction,
  );
  await Bun.sleep(pace);
  return 'done';
};

// The process names the modules it runs for `/api/me` by the ids the contract knows.
(MODULE_IDS as string[]).push(NOTES.id, WIKI.id);
(FACTS as unknown[]).push(NOTE_CREATED, NOTE_PINNED);
(bundledModules as unknown as BundledModule[]).push(
  { manifest: NOTES },
  { manifest: WIKI, factConsumers: { 'notes.created': deliver, 'notes.pinned': deliver } },
);
