/** Durable Web Push (#1405). After-commit calls only wake the worker; PostgreSQL owns accepted work. */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Attention } from '../../platform/attention';
import type { Logger } from '../../platform/logging';
import type { Counter } from '../../platform/metrics';
import type { WrittenNotice } from '../../platform/ports/notification-sink';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { PUSH_POSTS_AT_ONCE, PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { createDelivery, type PushPost } from './delivery';
import { currentPushDevice, currentPushSource } from './authority';
import { devicesFor, routeInbox, type PushKeys } from './devices';
import { createFailureCount } from './failures';
import { maintainPushes } from './maintenance';
import { claimPush, type PushClaim } from './queue';
import { settlePush, type PushOutcome } from './queue-result';
import type { NoticeWords, PushNotices } from './notices';

export { PUSH_FAILURES_MAX, type PushPost } from './delivery';
export { NOTICE_PUSH_BUDGET } from '../../platform/push-policy';
export const PUSH_TIMEOUT_MS = 5_000;
export const HELD_PUSH_MAX_MS = PUSH_TTL_SECONDS * 1_000;
const POLL_MS = 1_000;
const FLUSH_BOUND_MS = 3_000;
const MAX_MAINTENANCE_PASSES = 4;

export interface PushSender {
  readonly told: (messageId: string, userIds: readonly string[]) => void;
  readonly toldInbox: (notices: readonly WrittenNotice[]) => void;
  /** Drain due durable work now, including eligible quiet work; tests need no real-time sleep. */
  readonly releaseHeld: () => Promise<void>;
  /** Drain currently due work within the shutdown bound, leaving delayed and unfinished work durable. */
  readonly flush: (boundMs?: number) => Promise<void>;
}

export interface PushSenderDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly keys: PushKeys;
  readonly post: PushPost;
  readonly attention: Attention;
  readonly notices: PushNotices;
  readonly noticeWords: NoticeWords;
  readonly inboxKinds: ReadonlyMap<string, string>;
  readonly effectiveModules: EntitlementPolicy['effective'];
  readonly owner: string;
  /** The composition root opens this only after migrations and persisted settings are ready. */
  readonly available?: () => boolean;
  readonly failures?: Counter<'reason' | 'module'>;
}

export const createPushSender = async (
  dependencies: PushSenderDependencies,
): Promise<PushSender> => {
  const { database, clock, log } = dependencies;
  const failed = createFailureCount(dependencies);
  const deliver = await createDelivery(dependencies, { failed });
  const running = new Set<Promise<void>>();
  let pumping: Promise<void> | undefined;
  let wakeAgain = false;
  let paused = false;
  let lastMaintenance = -Infinity;
  let maintenanceBacklog = false;
  let continuing: ReturnType<typeof setTimeout> | undefined;

  // Accessors preserve the fact that asynchronous callbacks may change these flags across awaits.
  const isPaused = (): boolean => paused;
  const hasWorkHint = (): boolean => wakeAgain || maintenanceBacklog;
  const available = (): boolean => dependencies.available?.() !== false;

  const deliverClaim = async (claim: PushClaim): Promise<PushOutcome> => {
    if (
      (await currentPushDevice(dependencies, claim)) === undefined ||
      !(await currentPushSource(dependencies, claim))
    )
      return { kind: 'canceled' };
    if (claim.source === 'message') {
      const devices = await devicesFor(
        dependencies,
        claim.recordId,
        [claim.userId],
        claim.sourceId,
      );
      const device = devices.find(
        (row) =>
          row.id === claim.subscriptionId &&
          row.generation === claim.generation &&
          row.sessionId === claim.sessionId &&
          row.userId === claim.userId &&
          row.workspaceId === claim.workspaceId,
      );
      return device === undefined ? { kind: 'canceled' } : await deliver(device, claim);
    }
    const routed = await routeInbox(dependencies, [claim.recordId]);
    if (routed.waiting.has(claim.recordId)) return { kind: 'held' };
    const device = routed.devices.find(
      (row) =>
        row.id === claim.subscriptionId &&
        row.generation === claim.generation &&
        row.sessionId === claim.sessionId &&
        row.userId === claim.userId &&
        row.workspaceId === claim.workspaceId,
    );
    return device === undefined ? { kind: 'canceled' } : await deliver(device, claim);
  };

  const run = async (claim: PushClaim): Promise<void> => {
    let outcome: PushOutcome;
    try {
      outcome = await deliverClaim(claim);
    } catch (error) {
      failed('error', 1, claim.module);
      log.error('push delivery failed', { stage: 'delivering durable push', err: error });
      outcome = { kind: 'retry' };
    }
    await settlePush(database, claim, outcome, clock);
  };

  const wake = (): Promise<void> => {
    if (!available()) return Promise.resolve();
    wakeAgain = true;
    if (pumping !== undefined) return pumping;
    clearTimeout(starting);
    clearTimeout(continuing);
    pumping = (async (): Promise<void> => {
      let passes = 0;
      do {
        wakeAgain = false;
        if (maintenanceBacklog || clock.now().getTime() - lastMaintenance >= 60_000) {
          maintenanceBacklog = await maintainPushes(database, clock.now(), log, failed);
          lastMaintenance = clock.now().getTime();
        }
        while (!isPaused() && running.size < PUSH_POSTS_AT_ONCE) {
          const claim = await claimPush(dependencies);
          if (claim === undefined) break;
          const task = run(claim)
            .catch((error: unknown) => {
              // Lost acknowledgement remains leased and recoverable. Never turn a source write into an error.
              failed('error', 1, claim.module);
              log.error('push delivery failed', { stage: 'settling durable push', err: error });
            })
            .finally(() => {
              running.delete(task);
              if (!isPaused()) void wake();
            });
          running.add(task);
        }
        maintenanceBacklog =
          (await maintainPushes(database, clock.now(), log, failed, false)) || maintenanceBacklog;
        passes++;
      } while (
        hasWorkHint() &&
        !isPaused() &&
        running.size < PUSH_POSTS_AT_ONCE &&
        passes < MAX_MAINTENANCE_PASSES
      );
    })()
      .catch((error: unknown) => {
        wakeAgain = false;
        maintenanceBacklog = false;
        lastMaintenance = -Infinity;
        failed('error');
        log.error('push delivery failed', { stage: 'claiming durable pushes', err: error });
      })
      .finally(() => {
        pumping = undefined;
        if (hasWorkHint() && !isPaused()) {
          continuing = setTimeout(() => {
            void wake();
          }, 0);
          continuing.unref();
        }
      });
    return pumping;
  };

  const drain = async (): Promise<void> => {
    if (!available()) return;
    paused = false;
    while (!isPaused()) {
      await wake();
      if (running.size === 0 && pumping === undefined && !maintenanceBacklog) return;
      if (running.size === 0) continue;
      await Promise.race(running);
    }
  };
  // A restart recovers committed work without any after-commit callback or another incoming message.
  const starting = setTimeout(() => {
    void wake();
  }, 0);
  starting.unref();
  const polling = setInterval(() => {
    if (!isPaused()) void wake();
  }, POLL_MS);
  polling.unref();

  return {
    told: (_messageId, userIds): void => {
      if (userIds.length > 0) {
        paused = false;
        void wake();
      }
    },
    toldInbox: (notices): void => {
      if (notices.length > 0) {
        paused = false;
        void wake();
      }
    },
    releaseHeld: drain,
    flush: async (boundMs = FLUSH_BOUND_MS): Promise<void> => {
      clearTimeout(starting);
      clearInterval(polling);
      clearTimeout(continuing);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<'bound'>((resolve) => {
        timer = setTimeout(() => {
          resolve('bound');
        }, boundMs);
      });
      const result = await Promise.race([drain().then(() => 'drained' as const), bound]);
      clearTimeout(timer);
      paused = true;
      if (result === 'bound') log.warn('pushes left at shutdown', { running: running.size });
    },
  };
};
