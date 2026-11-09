/**
 * What __ID__ does without each optional partner (D-291): one scenario for each, run by `degradation.test.ts` on the build
 * composed without the partner. Replace the stub with what the module's `degrades` sentence says a person then sees.
 *
 * For a partner whose records you link (D-291), the scenario asks the module's own ports what a link is without it:
 *
 *   partner: async ({ composition }) => {
 *     const ports = composition.portsFor('__ID__', database);
 *     const scope = { workspaceId, modules: null };
 *     expect(await ports.resolveRef({ module: 'partner', type: 'record', id }, scope)).toEqual({ status: 'unavailable' });
 *   },
 */
import type { Degradation } from '../../testing/degradation';
import type { __CAMEL__Module } from './module';

export const degradation: Degradation<typeof __CAMEL__Module.manifest> = {
__SCENARIOS__
};
