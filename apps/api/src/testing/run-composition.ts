import { compositionFor } from '../composition';

/**
 * The composition of the run: what a process started with the run's `MODULES` runs, every module when it is unset. What a
 * test builds its application from (`testDependencies`) and what `needs.ts` asks which modules run.
 */
export const runComposition = compositionFor(process.env['MODULES']);
