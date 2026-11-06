/**
 * The background loops chat runs inside the API process (`MODULES.md` §9): the delivery of scheduled messages and of
 * reminders when they fall due. Each is safe on several nodes because it claims its due rows with `FOR UPDATE SKIP
 * LOCKED`, and each iteration is chat's own: it takes its connections from chat's share and is cut off at chat's
 * `workerDeadline`, so a hung delivery holds neither the pool nor the loop behind it.
 */
import type { ModuleWorker } from '../../modules/workers/module-workers';
import { deliverReminders } from './reminders/delivery';
import { deliverScheduled } from './scheduled/delivery';

/** How soon after its time a message or a reminder is delivered: what a person who set one waits at most, a node idle. */
const DELIVERY_INTERVAL_MS = 15_000;

export const chatWorkers: readonly ModuleWorker[] = [
  {
    name: 'deliver:scheduled',
    intervalMs: DELIVERY_INTERVAL_MS,
    work: async (context): Promise<void> => {
      await deliverScheduled(context);
    },
  },
  {
    name: 'deliver:reminders',
    intervalMs: DELIVERY_INTERVAL_MS,
    work: async (context): Promise<void> => {
      await deliverReminders(context);
    },
  },
];
