/**
 * What __ID__ does when another module tells it something (`docs/MODULE-GUIDE.md` §5, `MODULES.md` §4): none yet. A fact it handles
 * is listed under `consumes` in its manifest, with the module that publishes it under `requires` or `optional` (the registry refuses
 * a fact of a module it does not name, D-353), and has a handler here made with `consumerOf`, which hands it the payload typed by the
 * fact's declaration:
 *
 *   export const __CAMEL__FactConsumers: FactConsumers = {
 *     ...consumerOf(OTHER_CREATED, async (fact, transaction, ports, seam) => {
 *       // Delivered at least once and in no order: the same `fact.factId` may come again, after a later fact.
 *       // Read the state now (it may have changed since the fact was published), in `fact.workspaceId` and no other.
 *       return 'done';
 *     }),
 *   };
 *
 * What __ID__ tells others is declared in `__UPPER___FACTS` (`packages/types/src/__ID__.ts`), listed under `publishes` and published
 * with `publishFact` in the transaction of what it reports. `publishAndDeliver` (`apps/api/src/testing/fact-delivery.ts`) runs a
 * publish and its delivery in an integration test.
 */
import type { FactConsumers } from '../../platform/fact-consumers';

export const __CAMEL__FactConsumers: FactConsumers = {};
