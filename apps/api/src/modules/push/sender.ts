/** Durable device push (#1405, #1559). After-commit calls only wake the worker. */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Attention } from '../../platform/attention';
import type { Logger } from '../../platform/logging';
import { withoutRequest } from '../../platform/logging';
import type { Counter } from '../../platform/metrics';
import type { WrittenNotice } from '../../platform/ports/notification-sink';
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import { PUSH_POSTS_AT_ONCE, PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { enqueuePush, type PushCapture } from '../../platform/push-work';
import { createDelivery, type PushPost } from './delivery';
import { currentPushDevice, currentPushSource } from './authority';
import { devicesFor, routeInbox, type Device, type PushKeys } from './devices';
import { createFailureCount } from './failures';
import { maintainPushes } from './maintenance';
import { beginPushAttempt, claimPush, ownsPushClaim, type PushClaim } from './queue';
import { settlePush, type PushOutcome } from './queue-result';
import type { NoticeWords, PushNotices } from './notices';
import type { WorkspaceAccessLifetime } from '../../platform/workspace-access-facts';
import type { ApnsProvider } from './apns';
import { inDeepWork } from '../workspaces/deep-work';
import { applyPushResponse } from './response';

export { PUSH_FAILURES_MAX, type PushPost } from './delivery';
export { NOTICE_PUSH_BUDGET } from '../../platform/push-policy';
export const PUSH_TIMEOUT_MS = 5_000;
export const HELD_PUSH_MAX_MS = PUSH_TTL_SECONDS * 1_000;
const POLL_MS = 1_000;
const FLUSH_BOUND_MS = 3_000;
const MAX_MAINTENANCE_PASSES = 4;

export interface PushSender {
  readonly capture?: PushCapture;
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
  readonly sessionLifetime?: () => WorkspaceAccessLifetime;
  readonly log: Logger;
  readonly keys: PushKeys;
  readonly post: PushPost;
  readonly apns?: { readonly scope: string; readonly send: ApnsProvider };
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
  const { database, clock, log, apns } = dependencies;
  const failed = createFailureCount(dependencies);
  const deliver = await createDelivery(dependencies, { failed });
  const queue = { ...dependencies, ...(apns === undefined ? {} : { apnsScope: apns.scope }) };
  const capture: PushCapture | undefined =
    apns === undefined
      ? undefined
      : (transaction, now, work): Promise<void> =>
          enqueuePush(transaction, now, work, undefined, apns.scope);
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

  const deliverTo = async (device: Device, claim: PushClaim): Promise<PushOutcome> => {
    if (device.provider === 'web') return await deliver(device, claim);
    if (apns === undefined) return { kind: 'canceled' };
    const posted = await apns.send({
      deviceToken: device.deviceToken,
      payload: device.payload,
      expiresAt: claim.expiresAt,
      collapseId: claim.intentId,
      beforePost: async () => {
        if (
          (await currentPushDevice(dependencies, claim)) === undefined ||
          !(await currentPushSource(dependencies, claim)) ||
          dependencies.attention.active(device.userId, device.workspaceId)
        )
          return { kind: 'canceled' };
        const quiet = await inDeepWork(database, device.workspaceId, [device.userId], clock.now());
        if (quiet.has(device.userId)) return { kind: 'held' };
        if (!(await beginPushAttempt(database, claim, clock.now()))) return { kind: 'canceled' };
        if (!(await ownsPushClaim(database, claim, clock.now()))) return { kind: 'canceled' };
        if (
          (await currentPushDevice(dependencies, claim)) === undefined ||
          !(await currentPushSource(dependencies, claim))
        )
          return { kind: 'canceled' };
        return undefined;
      },
    });
    if (posted.kind === 'refused') failed('refused', 1, device.module);
    if (posted.kind === 'retry') failed('not_taken', 1, device.module);
    if (posted.kind !== 'unregistered') return posted;
    if (
      posted.invalidatedAt !== undefined &&
      posted.invalidatedAt >= device.registeredAt.getTime()
    ) {
      await applyPushResponse(database, clock, claim, device, async (tx) => {
        await tx
          .deleteFrom('apns_subscriptions')
          .where('session_id', '=', device.sessionId)
          .where('generation', '=', device.generation)
          .where('provider_scope', '=', device.apnsScope)
          .execute();
      });
    }
    return { kind: 'canceled', status: posted.status };
  };

  const deliverClaim = async (claim: PushClaim): Promise<PushOutcome> => {
    if (
      (await currentPushDevice(dependencies, claim)) === undefined ||
      !(await currentPushSource(dependencies, claim))
    )
      return { kind: 'canceled' };
    const routing =
      claim.apnsScope === undefined
        ? dependencies
        : {
            ...dependencies,
            keys: (): Promise<undefined> => Promise.resolve(undefined),
            apnsScope: claim.apnsScope,
          };
    const routed =
      claim.source === 'message'
        ? {
            devices: await devicesFor(routing, claim.recordId, [claim.userId], claim.sourceId),
            waiting: new Set<string>(),
          }
        : await routeInbox(routing, [claim.recordId]);
    if (routed.waiting.has(claim.recordId)) return { kind: 'held' };
    const device = routed.devices.find(
      (row) =>
        row.id === claim.subscriptionId &&
        row.generation === claim.generation &&
        row.sessionId === claim.sessionId &&
        row.userId === claim.userId &&
        row.workspaceId === claim.workspaceId &&
        (row.provider === 'apns' ? row.apnsScope : undefined) === claim.apnsScope,
    );
    return device === undefined ? { kind: 'canceled' } : await deliverTo(device, claim);
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
    pumping = withoutRequest(async (): Promise<void> => {
      let passes = 0;
      do {
        wakeAgain = false;
        if (maintenanceBacklog || clock.now().getTime() - lastMaintenance >= 60_000) {
          maintenanceBacklog = await maintainPushes(database, clock.now(), log, failed);
          lastMaintenance = clock.now().getTime();
        }
        while (!isPaused() && running.size < PUSH_POSTS_AT_ONCE) {
          const claim = await claimPush(queue);
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
    })
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
    ...(capture === undefined ? {} : { capture }),
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
