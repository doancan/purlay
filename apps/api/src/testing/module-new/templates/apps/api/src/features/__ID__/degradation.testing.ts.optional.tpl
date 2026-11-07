/**
 * What __ID__ does without each optional partner (D-291): one scenario for each, run by `degradation.test.ts` on the build
 * composed without the partner. Replace the stub with what the module's `degrades` sentence says a person then sees.
 */
import type { Degradation } from '../../testing/degradation';
import type { __CAMEL__Module } from './module';

export const degradation: Degradation<typeof __CAMEL__Module.manifest> = {
__SCENARIOS__
};
