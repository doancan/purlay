/**
 * Telling a person's devices what needs them, after the write that decided it has committed
 * (#78, D-126).
 *
 * - **Who:** only the people a write told for the first time (`notify` returns them), and of those
 *   only a notification still unread, not held back by Deep Work, of a reason that needs them, on a
 *   message not deleted — on a device whose session is live and whose subscription was made with the
 *   server's current key. Looked up once per write, then current source access, unread state,
 *   preferences, attention and session are checked per device immediately before posting. Pushed
 *   by the node that committed, never through the bus: a second node does not push it twice (§8).
 * - **What:** who and why, in the person's language (`words.ts`) and where, never what was written.
 * - **Where it goes:** the push service the browser named, through the checked address and lookup an
 *   external image uses (§6).
 * - **What the answer does:** 2xx keeps the device; 404 or 410 forgets it (the browser dropped it);
 *   400, 401, 403 or 413 is this server's request refused — said loudly, and no device's fault; any
 *   other answer, a timeout or a network failure records a streak bounded by `PUSH_FAILURES_MAX`;
 *   the subscription stays available for later messages and a successful delivery resets the streak.
 * - **A module's notice** (`toldInbox`, D-286 §9) is the same path with its own rows: only an entry still unread, of a person
 *   not erased, in a workspace not deleted, worded by the module that declares its kind. A person in Deep Work or in their
 *   quiet hours is not told now: the push waits **in memory, on the node that committed it**, and is asked again every
 *   `HELD_CHECK_MS`; it goes once they are out of it, unless they read it meanwhile, and is dropped and counted after
 *   `HELD_PUSH_MAX_MS`, which is how long the device would keep it anyway. A restart forgets what waits; the notice is in the
 *   inbox. A person in front of the page is not told, now or later, as for a message.
 * - **A loop cannot spam a device:** the pushes of one person for one kind of one module are held to `NOTICE_PUSH_BUDGET`; the
 *   rest are dropped and counted (`throttled`), and the notice is in the inbox.
 * - **Detached, bounded and fair:** the write's caller does not wait. At most `POSTS_AT_ONCE` are in
 *   flight on the node and `POSTS_PER_PERSON` for any one person, so one person's slow or hostile
 *   push services cannot hold everybody else's; past `QUEUE_MAX` waiting, the oldest push is dropped and
 *   said. `flush` waits for them at shutdown, within its bound.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Attention } from '../../platform/attention';
import type { Logger } from '../../platform/logging';
import type { Counter } from '../../platform/metrics';
import type { WrittenNotice } from '../../platform/ports/notification-sink';
import { createDelivery, PUSH_TTL_SECONDS, type PushPost } from './delivery';
import { devicesFor, routeInbox, type PushKeys } from './devices';
import { createFailureCount } from './failures';
import { createHeldNotices } from './held';
import { createDeviceLine } from './line';
import type { NoticeWords, PushNotices } from './notices';

export { PUSH_FAILURES_MAX, type PushPost } from './delivery';

/** Pushes waiting their turn; past it one is dropped, and said. */
const QUEUE_MAX = 1_000;
/** How long a push service has to answer. */
export const PUSH_TIMEOUT_MS = 5_000;
/** How long a shutdown waits for pushes on their way. */
const FLUSH_BOUND_MS = 3_000;
/** How long a push held by Deep Work or quiet hours waits: as long as a push service keeps it for a device that is off. */
export const HELD_PUSH_MAX_MS = PUSH_TTL_SECONDS * 1_000;
/**
 * Pushes of a module's notices one person is told of one kind: three at once, then one a minute (red-team F8). A person
 * assigned a handful of things in a minute is told of each; a loop that assigns a thousand is told of three, and the rest
 * are in the inbox, where they are bounded as well (`UNREAD_PER_MODULE_MAX`). Kept in this process, as what is held is, so
 * each node of a cluster counts its own. Provisional (O-4).
 */
export const NOTICE_PUSH_BUDGET = { perSecond: 1 / 60, burst: 3 } as const;
/** How often what is held is asked again whether the person is still in Deep Work or their quiet hours. */
const HELD_CHECK_MS = 60_000;

export interface PushSender {
  /** The people `messageId` told for the first time; returns at once. */
  readonly told: (messageId: string, userIds: readonly string[]) => void;
  /** The notices a module wrote to the inbox, once their transaction has committed; returns at once. */
  readonly toldInbox: (notices: readonly WrittenNotice[]) => void;
  /** Asks again, now, whether what waits for Deep Work or quiet hours may go: the timer's work, so a test need not wait for it. */
  readonly releaseHeld: () => Promise<void>;
  /** Waits for every push on its way, `boundMs` at most, and says what it left. */
  readonly flush: (boundMs?: number) => Promise<void>;
}

/** Whether one more push of a kind may go to a person: a token bucket of `NOTICE_PUSH_BUDGET`, made where the server is composed. */
export interface NoticeThrottle {
  readonly consume: (key: string) => Promise<boolean>;
}

export interface PushSenderDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly keys: PushKeys;
  /** How a push reaches its service: `postExternal` on the checked lookup, where the server is composed. */
  readonly post: PushPost;
  /**
   * Who is in front of a workspace's page now (D-143): their pushes for it are held, not sent later —
   * what they are looking at already says it.
   */
  readonly attention: Attention;
  /** What the write told, from whoever owns the writes: chat's notifications, where the server is composed (D-250). */
  readonly notices: PushNotices;
  /** Held to `NOTICE_PUSH_BUDGET` for each person, module and kind of notice (red-team F8). */
  readonly noticeThrottle: NoticeThrottle;
  /** What a module's notice in the inbox is said as, from the modules that declare the kinds (D-286 §9). */
  readonly noticeWords: NoticeWords;
  /** Where a push that did not reach its service is counted, by why (D-221); absent, it is not. */
  readonly failures?: Counter<'reason' | 'module'>;
  /** The module whose notices this sender delivers, for the failure counter's label; absent, the core's. */
  readonly owner?: string;
  /**
   * Pushes that may wait, in line and held, before the oldest are let go: `QUEUE_MAX` where absent. A test of the
   * bound gives a small one, as a thousand real encryptions is seconds of work to prove what three prove.
   */
  readonly queueMax?: number;
}
export const createPushSender = async (
  dependencies: PushSenderDependencies,
): Promise<PushSender> => {
  const { clock, log } = dependencies;
  const queueMax = dependencies.queueMax ?? QUEUE_MAX;
  const failed = createFailureCount(dependencies);
  const held = createHeldNotices({ queueMax, maxMs: HELD_PUSH_MAX_MS, log, failed });
  const deliver = await createDelivery(dependencies, { failed, hold: held.hold });
  const line = createDeviceLine({ queueMax, deliver, log, failed });
  const fetching = new Set<Promise<void>>();

  /** Follows a lookup until it ends, so `flush` waits for it; its failure is counted and said, never thrown at the caller. */
  const follow = (lookup: Promise<void>, stage: string, about: Record<string, unknown>): void => {
    const found = lookup
      .catch((error: unknown) => {
        failed('error');
        log.error('push delivery failed', { ...about, stage, err: error });
      })
      .finally(() => {
        fetching.delete(found);
      });
    fetching.add(found);
  };

  const route = async (entryIds: readonly string[]): Promise<void> => {
    const { devices, waiting: stillWaiting } = await routeInbox(dependencies, entryIds);
    const now = clock.now().getTime();
    const eligible = devices.filter(
      (device) => !('entryId' in device.source) || held.mayTell(device.source.entryId, device.id),
    );
    for (const id of entryIds) {
      if (!stillWaiting.has(id)) held.release(id);
      else held.hold(id, now);
    }
    line.enqueue(eligible, { entries: entryIds.length });
  };

  const releaseHeld = async (): Promise<void> => {
    const due = held.takeDue(clock.now().getTime());
    if (due.length === 0) return;
    const asked = route(due);
    follow(asked, 'releasing held pushes', { entries: due.length });
    await asked.catch(() => undefined);
  };
  // Once a minute, the notices waiting for the end of Deep Work are asked again. Unreferenced: it never keeps a process alive.
  let releasingNow: Promise<void> | undefined;
  const releasing = setInterval(() => {
    // One at a time: a slow database must not let the next tick ask for what this one is still sending.
    if (releasingNow !== undefined) return;
    releasingNow = releaseHeld().finally(() => {
      releasingNow = undefined;
    });
  }, HELD_CHECK_MS);
  releasing.unref();

  return {
    told: (messageId, userIds): void => {
      if (userIds.length === 0) return;
      follow(
        devicesFor(dependencies, messageId, userIds).then((devices) => {
          line.enqueue(devices, { messageId });
        }),
        'finding devices',
        { messageId },
      );
    },
    toldInbox: (notices): void => {
      if (notices.length === 0) return;
      follow(
        (async (): Promise<void> => {
          const toTell: string[] = [];
          for (const notice of notices) {
            const key = `${notice.recipientId}:${notice.module}:${notice.kind}`;
            if (await dependencies.noticeThrottle.consume(key)) toTell.push(notice.entryId);
            else failed('throttled', 1, notice.module);
          }
          if (toTell.length > 0) await route(toTell);
        })(),
        'finding devices for inbox notices',
        { entries: notices.length },
      );
    },
    releaseHeld,
    flush: async (boundMs = FLUSH_BOUND_MS): Promise<void> => {
      clearInterval(releasing);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<'bound'>((resolve) => {
        timer = setTimeout(() => {
          resolve('bound');
        }, boundMs);
      });
      const drained = (async (): Promise<'drained'> => {
        while (fetching.size > 0 || line.counts().running > 0 || line.counts().waiting > 0) {
          await Promise.all([...fetching, ...line.inFlight()]);
          line.restart();
        }
        return 'drained';
      })();
      const outcome = await Promise.race([drained, bound]);
      clearTimeout(timer);
      if (outcome === 'bound') {
        log.warn('pushes left at shutdown', line.counts());
      }
    },
  };
};
