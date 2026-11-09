/**
 * The line of devices waiting for a push and the pump that starts them (D-298): at most `POSTS_AT_ONCE` in
 * flight on the node and `POSTS_PER_PERSON` for any one person, so one person's slow or hostile push services
 * cannot hold everybody else's. The line holds `queueMax`: past it the oldest in line go, and the count is said.
 */
import type { Logger } from '../../platform/logging';
import { admit } from '../../platform/bounded';
import type { Device } from './devices';
import type { FailureCount } from './failures';

/** Pushes in flight at once on this node. */
const POSTS_AT_ONCE = 16;
/** Pushes in flight at once for one person: their devices cannot hold the node. */
const POSTS_PER_PERSON = 2;

export interface DeviceLine {
  /** Puts devices behind what waits, drops the oldest past the bound, and starts what may start. */
  readonly enqueue: (devices: readonly Device[], about: Record<string, unknown>) => void;
  /** The pushes in flight now. */
  readonly inFlight: () => Promise<void>[];
  /** Starts the line again if nothing is in flight to start it. */
  readonly restart: () => void;
  readonly counts: () => { readonly running: number; readonly waiting: number };
}

interface DeviceLineOptions {
  readonly queueMax: number;
  readonly deliver: (device: Device) => Promise<void>;
  readonly log: Logger;
  readonly failed: FailureCount;
}

export const createDeviceLine = ({
  queueMax,
  deliver,
  log,
  failed,
}: DeviceLineOptions): DeviceLine => {
  const waiting: Device[] = [];
  const active = new Map<string, number>();
  const running = new Set<Promise<void>>();

  /** Starts what may start: the oldest waiting push whose person is under their share. */
  const pump = (): void => {
    while (running.size < POSTS_AT_ONCE) {
      const next = waiting.findIndex(
        (device) => (active.get(device.userId) ?? 0) < POSTS_PER_PERSON,
      );
      if (next === -1) return;
      const [device] = waiting.splice(next, 1);
      if (device === undefined) return;
      active.set(device.userId, (active.get(device.userId) ?? 0) + 1);
      const task = deliver(device)
        .catch((error: unknown) => {
          // A device's failure is that device's; the rest still go. Said with nothing of the person.
          failed('error', 1, device.module);
          log.error('push delivery failed', { err: error });
        })
        .finally(() => {
          running.delete(task);
          const left = (active.get(device.userId) ?? 1) - 1;
          if (left === 0) active.delete(device.userId);
          else active.set(device.userId, left);
          pump();
        });
      running.add(task);
    }
  };

  return {
    enqueue: (devices, about): void => {
      const dropped = admit(waiting, devices, queueMax);
      if (dropped > 0) {
        failed('dropped', dropped);
        log.warn('push dropped: too many waiting', { ...about, dropped });
      }
      pump();
    },
    inFlight: (): Promise<void>[] => [...running],
    restart: (): void => {
      if (running.size === 0 && waiting.length > 0) pump();
    },
    counts: () => ({ running: running.size, waiting: waiting.length }),
  };
};
