/**
 * The notices that wait in memory for Deep Work or quiet hours to end (D-286 §9, D-298): what is held, since
 * when, and for a partial hold which devices were already told. Bounded: past `queueMax` the oldest are let
 * go, and said.
 */
import type { Logger } from '../../platform/logging';
import { dropOldest } from '../../platform/bounded';
import type { FailureCount } from './failures';

export interface HeldNotices {
  /** Holds `id` from `now`; a device set keeps a partial hold from repeating devices already told. */
  readonly hold: (id: string, now: number, deviceId?: string) => void;
  /** Lets `id` go: it is no longer waiting. */
  readonly release: (id: string) => void;
  /** Whether `deviceId` is still to be told of `id`: not a device a partial hold has already told. */
  readonly mayTell: (id: string, deviceId: string) => boolean;
  /** Lets go of what has waited past `maxMs`, said and counted, and answers the ids that are still due. */
  readonly takeDue: (now: number) => string[];
}

interface HeldNoticesOptions {
  readonly queueMax: number;
  /** How long a notice waits before it is dropped. */
  readonly maxMs: number;
  readonly log: Logger;
  readonly failed: FailureCount;
}

export const createHeldNotices = ({
  queueMax,
  maxMs,
  log,
  failed,
}: HeldNoticesOptions): HeldNotices => {
  /** One entry per held notice. */
  const held = new Map<
    string,
    { readonly since: number; readonly devices: Set<string> | undefined }
  >();
  return {
    hold: (id, now, deviceId): void => {
      const entry = held.get(id);
      if (entry === undefined) {
        held.set(id, {
          since: now,
          devices: deviceId === undefined ? undefined : new Set([deviceId]),
        });
      } else if (deviceId !== undefined) {
        entry.devices?.add(deviceId);
      }
      // The oldest let go, the newest kept (`bounded.ts`): it is what the person has just been told of.
      const dropped = dropOldest(held, queueMax).length;
      if (dropped > 0) {
        failed('dropped', dropped);
        log.warn('push dropped: too many held', { dropped });
      }
    },
    release: (id): void => {
      held.delete(id);
    },
    mayTell: (id, deviceId): boolean => {
      const selected = held.get(id)?.devices;
      return selected === undefined || selected.has(deviceId);
    },
    takeDue: (now): string[] => {
      const due: string[] = [];
      for (const [id, { since }] of held) {
        if (now - since > maxMs) {
          held.delete(id);
          failed('dropped');
          log.info('push dropped: held longer than a device keeps it');
        } else {
          due.push(id);
        }
      }
      return due;
    },
  };
};
