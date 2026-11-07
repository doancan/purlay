/**
 * The background loops __ID__ runs inside the API process (`MODULES.md` §9): none. A loop is added here as
 * `{ name, intervalMs, work }`; it runs in the module's share and is cut off at its `workerDeadline`.
 */
import type { ModuleWorker } from '../../modules/workers/module-workers';

export const __CAMEL__Workers: readonly ModuleWorker[] = [];
