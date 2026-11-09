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
 *   other answer, a timeout or a network failure counts against the device, and `PUSH_FAILURES_MAX`
 *   in a row forgets it.
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
 *   push services cannot hold everybody else's; past `QUEUE_MAX` waiting, a push is dropped and
 *   said. `flush` waits for them at shutdown, within its bound.
 */
import type { Executor } from '@purlay/db';
import { NEEDS_YOU, type PushLocale, type PushPayload } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Attention } from '../../platform/attention';
import type { Logger } from '../../platform/logging';
import type { Counter, PushFailure } from '../../platform/metrics';
import { CORE_OWNER } from '../../platform/module-kit/ownership';
import type { WrittenNotice } from '../../platform/ports/notification-sink';
import type { Posted } from '../images/fetch-external';
import { externalImageAddress } from '../images/proxy';
import { inDeepWork } from '../workspaces/deep-work';
import type { NoticeWords, PushNotices } from './notices';
import { encryptPush, freshParts } from './encrypt';
import { vapidAuthorization, vapidSigningKey, type VapidKeys } from './vapid';
import { pushBody, saidOf } from './words';

/** Deliveries in a row a push service did not take before the device is forgotten. */
export const PUSH_FAILURES_MAX = 5;
/** Pushes in flight at once on this node. */
const POSTS_AT_ONCE = 16;
/** Pushes in flight at once for one person: their devices cannot hold the node. */
const POSTS_PER_PERSON = 2;
/** Pushes waiting their turn; past it one is dropped, and said. */
const QUEUE_MAX = 1_000;
/** How long a push service has to answer. */
export const PUSH_TIMEOUT_MS = 5_000;
/** How long a push service keeps it for a device that is off: a day, then it is stale. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
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

export type PushPost = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
) => Promise<Posted>;

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
  readonly keys: VapidKeys;
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
}

interface Subscription {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly locale: string;
}

interface Device extends Omit<Subscription, 'locale'> {
  readonly workspaceId: string;
  readonly source: { readonly messageId: string } | { readonly entryId: string };
  readonly payload: PushPayload;
  /** The module whose notice this is, for the failure counter's label; absent, the sender's owner (chat's messages). */
  readonly module?: string;
}

/** The answers that are this server's request refused, not the device's absence. */
const OUR_REQUEST_REFUSED = new Set([400, 401, 403, 413]);

/** The live devices of these people whose subscription was made with the server's current key, in the order they were made. */
const subscriptionsOf = async (
  { database, clock, keys }: PushSenderDependencies,
  userIds: readonly string[],
): Promise<Subscription[]> =>
  await database
    .selectFrom('push_subscriptions as s')
    .innerJoin('users as person', 'person.id', 's.user_id')
    .innerJoin('sessions as live', 'live.id', 's.session_id')
    .select([
      's.id',
      's.user_id as userId',
      's.session_id as sessionId',
      's.endpoint',
      's.p256dh',
      's.auth',
      'person.locale',
    ])
    .where('s.user_id', 'in', userIds)
    .where('person.deleted_at', 'is', null)
    .where('live.expires_at', '>', clock.now())
    .where('s.server_key', '=', keys.publicKey)
    // A person's devices in the order they were subscribed: the same order every time.
    .orderBy('s.created_at')
    .orderBy('s.id')
    .execute();

const localeOf = (locale: string): PushLocale => (locale === 'tr' ? 'tr' : 'en');

const devicesFor = async (
  dependencies: PushSenderDependencies,
  messageId: string,
  userIds: readonly string[],
): Promise<Device[]> => {
  const { database, attention, log, notices } = dependencies;
  const told = await notices.of(database, messageId, userIds);
  if (told.length === 0) return [];
  const subscriptions = await subscriptionsOf(dependencies, [
    ...new Set(told.map((notice) => notice.userId)),
  ]);
  const workspaces = await database
    .selectFrom('workspaces')
    .select(['id', 'slug'])
    .where('id', 'in', [...new Set(told.map((notice) => notice.workspaceId))])
    .execute();
  const slugs = new Map(workspaces.map((workspace) => [workspace.id, workspace.slug]));
  const rows = subscriptions.flatMap((subscription) =>
    told
      .filter((notice) => notice.userId === subscription.userId)
      .flatMap((notice) => {
        const slug = slugs.get(notice.workspaceId);
        return slug === undefined ? [] : [{ ...subscription, ...notice, slug }];
      }),
  );
  const held = new Set<string>();
  const devices = rows.flatMap((row) => {
    const reason =
      row.type === 'reminder' ? 'reminder' : NEEDS_YOU.find((known) => known === row.type);
    if (reason === undefined) return [];
    // In front of this workspace's page: held, never sent later (D-143, D-12).
    if (attention.active(row.userId, row.workspaceId)) {
      held.add(row.userId);
      return [];
    }
    return [
      {
        ...row,
        source: { messageId },
        payload: {
          // A channel by its name; a group by its people; a direct message by who wrote it.
          title:
            row.channelName !== null ? `#${row.channelName}` : (row.groupNames ?? row.authorName),
          body: pushBody(
            localeOf(row.locale),
            saidOf(reason, row.groupNames !== null, row.rootSenderId, row.userId),
            row.authorName,
          ),
          url: `/w/${row.slug}/c/${row.channelId}${row.threadId === null ? '' : `?thread=${encodeURIComponent(row.threadId)}`}`,
          tag: `channel:${row.channelId}`,
        },
      },
    ];
  });
  if (held.size > 0) log.debug('push held: the person is active', { messageId, people: held.size });
  return devices;
};

/** Where inbox entries stand for a push: the devices to tell now, and the entries that wait for Deep Work or quiet hours to end. */
interface Routed {
  readonly devices: Device[];
  readonly waiting: ReadonlySet<string>;
}

const routeInbox = async (
  dependencies: PushSenderDependencies,
  entryIds: readonly string[],
): Promise<Routed> => {
  const { database, clock, attention, log, noticeWords } = dependencies;
  const entries = await database
    .selectFrom('inbox_entries as e')
    .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
    .innerJoin('users as person', 'person.id', 'e.user_id')
    .innerJoin('users as actor', 'actor.id', 'e.actor_id')
    .select([
      'e.id',
      'e.user_id as userId',
      'e.workspace_id as workspaceId',
      'e.kind',
      'e.subject_id as subjectId',
      'w.slug',
      'w.name as workspaceName',
      'actor.display_name as actorName',
      'e.module',
    ])
    .where('e.id', 'in', entryIds)
    // What was read meanwhile, or whose person or workspace is gone, is not worth a push.
    .where('e.read_at', 'is', null)
    .where('w.deleted_at', 'is', null)
    .where('person.deleted_at', 'is', null)
    .execute();
  if (entries.length === 0) return { devices: [], waiting: new Set() };
  const now = clock.now();
  const quiet = new Map<string, ReadonlySet<string>>();
  for (const workspaceId of new Set(entries.map((entry) => entry.workspaceId))) {
    quiet.set(
      workspaceId,
      await inDeepWork(
        database,
        workspaceId,
        [...new Set(entries.filter((e) => e.workspaceId === workspaceId).map((e) => e.userId))],
        now,
      ),
    );
  }
  const waiting = new Set(
    entries.filter((entry) => quiet.get(entry.workspaceId)?.has(entry.userId)).map((e) => e.id),
  );
  const ready = entries.filter(
    (entry) => !waiting.has(entry.id) && !attention.active(entry.userId, entry.workspaceId),
  );
  if (ready.length === 0) return { devices: [], waiting };
  const subscriptions = await subscriptionsOf(dependencies, [
    ...new Set(ready.map((entry) => entry.userId)),
  ]);
  const devices = subscriptions.flatMap((subscription) =>
    ready
      .filter((entry) => entry.userId === subscription.userId)
      .flatMap((entry) => {
        const saying = noticeWords(entry.kind, localeOf(subscription.locale), entry.actorName);
        if (saying === undefined) {
          log.warn('push not sent: no words for the kind', { kind: entry.kind });
          return [];
        }
        return [
          {
            ...subscription,
            workspaceId: entry.workspaceId,
            source: { entryId: entry.id },
            module: entry.module,
            payload: {
              title: entry.workspaceName,
              body: saying.body,
              url: `/w/${entry.slug}/${saying.path}`,
              tag: `inbox:${entry.subjectId}`,
            },
          },
        ];
      }),
  );
  return { devices, waiting };
};

export const createPushSender = async (
  dependencies: PushSenderDependencies,
): Promise<PushSender> => {
  const { database, clock, log, keys, post } = dependencies;
  const failed = (reason: PushFailure, by = 1, module?: string): void => {
    dependencies.failures?.inc({ reason, module: module ?? dependencies.owner ?? CORE_OWNER }, by);
  };
  // Imported once, here, so a key that cannot sign stops the start rather than the first push.
  const signing = await vapidSigningKey(keys);
  const waiting: Device[] = [];
  const active = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const fetching = new Set<Promise<void>>();
  /** One entry per held notice; a device set keeps a partial hold from repeating devices already told. */
  const held = new Map<
    string,
    { readonly since: number; readonly devices: Set<string> | undefined }
  >();
  const hold = (id: string, now: number, deviceId?: string): void => {
    const entry = held.get(id);
    if (entry === undefined) {
      held.set(id, {
        since: now,
        devices: deviceId === undefined ? undefined : new Set([deviceId]),
      });
    } else if (deviceId !== undefined) {
      entry.devices?.add(deviceId);
    }
    for (const extra of [...held.keys()].slice(QUEUE_MAX)) {
      held.delete(extra);
      failed('dropped');
      log.warn('push dropped: too many held');
    }
  };

  const forget = async (device: Device): Promise<void> => {
    await database
      .deleteFrom('push_subscriptions')
      .where('id', '=', device.id)
      .where('user_id', '=', device.userId)
      .where('session_id', '=', device.sessionId)
      .execute();
  };

  /** Still the person's, in a live session: asked right before the push goes. */
  const stillTheirs = async (device: Device): Promise<boolean> =>
    (await database
      .selectFrom('push_subscriptions as s')
      .innerJoin('sessions as live', 'live.id', 's.session_id')
      .select('s.id')
      .where('s.id', '=', device.id)
      .where('s.user_id', '=', device.userId)
      .where('s.session_id', '=', device.sessionId)
      .where('live.expires_at', '>', clock.now())
      .executeTakeFirst()) !== undefined;

  const counted = async (device: Device, url: URL, posted: Posted): Promise<void> => {
    const row = await database
      .updateTable('push_subscriptions')
      .set((eb) => ({ failures: eb('failures', '+', 1) }))
      .where('id', '=', device.id)
      .where('user_id', '=', device.userId)
      .where('session_id', '=', device.sessionId)
      .returning('failures')
      .executeTakeFirst();
    const said = {
      host: url.hostname,
      ...(posted.kind === 'answered' ? { status: posted.status } : { reason: posted.reason }),
    };
    if (row !== undefined && row.failures >= PUSH_FAILURES_MAX) {
      log.info('push device forgotten', { ...said, failures: row.failures });
      await forget(device);
      return;
    }
    failed('not_taken', 1, device.module);
    log.warn('push not taken', said);
  };

  const stillRelevant = async (device: Device): Promise<boolean> => {
    if ('messageId' in device.source) {
      return await dependencies.notices.canDeliver(
        database,
        device.source.messageId,
        device.userId,
      );
    }
    return (
      (await database
        .selectFrom('inbox_entries as e')
        .innerJoin('workspace_members as member', (join) =>
          join
            .onRef('member.workspace_id', '=', 'e.workspace_id')
            .onRef('member.user_id', '=', 'e.user_id'),
        )
        .innerJoin('workspaces as w', 'w.id', 'e.workspace_id')
        .innerJoin('users as person', 'person.id', 'e.user_id')
        .select('e.id')
        .where('e.id', '=', device.source.entryId)
        .where('e.user_id', '=', device.userId)
        .where('e.read_at', 'is', null)
        .where('w.deleted_at', 'is', null)
        .where('person.deleted_at', 'is', null)
        .where('person.suspended_at', 'is', null)
        .executeTakeFirst()) !== undefined
    );
  };

  const deliver = async (device: Device): Promise<void> => {
    const url = externalImageAddress(device.endpoint);
    if (url === null) {
      log.info('push device forgotten', { reason: 'not an address push may reach' });
      await forget(device);
      return;
    }
    const body = await encryptPush(
      device,
      new TextEncoder().encode(JSON.stringify(device.payload)),
      await freshParts(),
    );
    const authorization = await vapidAuthorization(signing, keys, device.endpoint, clock.now());
    if (!(await stillTheirs(device))) return;
    if (!(await stillRelevant(device))) return;
    if (dependencies.attention.active(device.userId, device.workspaceId)) return;
    if (
      (await inDeepWork(database, device.workspaceId, [device.userId], clock.now())).has(
        device.userId,
      )
    ) {
      if ('entryId' in device.source) hold(device.source.entryId, clock.now().getTime(), device.id);
      return;
    }
    const posted = await post(
      url,
      {
        authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(PUSH_TTL_SECONDS),
        urgency: 'high',
      },
      body,
    );
    const status = posted.kind === 'answered' ? posted.status : null;
    if (status !== null && status >= 200 && status < 300) {
      await database
        .updateTable('push_subscriptions')
        .set({ failures: 0 })
        .where('id', '=', device.id)
        .where('failures', '>', 0)
        .execute();
      return;
    }
    if (status === 404 || status === 410) {
      log.info('push device forgotten', { host: url.hostname, status });
      await forget(device);
      return;
    }
    if (status !== null && OUR_REQUEST_REFUSED.has(status)) {
      // The keys, the token or the body: this server's to fix, not the browser's to pay for.
      failed('refused', 1, device.module);
      log.error('push refused: this server’s request', { host: url.hostname, status });
      return;
    }
    await counted(device, url, posted);
  };

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

  /** Puts devices in line for a push, as many as the line has room for; the rest are dropped, and said. */
  const enqueue = (devices: readonly Device[], about: Record<string, unknown>): void => {
    const room = Math.max(QUEUE_MAX - waiting.length, 0);
    if (devices.length > room) {
      failed('dropped', devices.length - room);
      log.warn('push dropped: too many waiting', { ...about, dropped: devices.length - room });
    }
    waiting.push(...devices.slice(0, room));
    pump();
  };

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
    const eligible = devices.filter((device) => {
      if (!('entryId' in device.source)) return true;
      const selected = held.get(device.source.entryId)?.devices;
      return selected === undefined || selected.has(device.id);
    });
    for (const id of entryIds) {
      if (!stillWaiting.has(id)) held.delete(id);
      else hold(id, now);
    }
    enqueue(eligible, { entries: entryIds.length });
  };

  const releaseHeld = async (): Promise<void> => {
    const now = clock.now().getTime();
    const due: string[] = [];
    for (const [id, { since }] of held) {
      if (now - since > HELD_PUSH_MAX_MS) {
        held.delete(id);
        failed('dropped');
        log.info('push dropped: held longer than a device keeps it');
      } else {
        due.push(id);
      }
    }
    if (due.length === 0) return;
    const asked = route(due);
    follow(asked, 'releasing held pushes', { entries: due.length });
    await asked.catch(() => undefined);
  };
  // Once a minute, the notices waiting for the end of Deep Work are asked again. Unreferenced: it never keeps a process alive.
  const releasing = setInterval(() => {
    void releaseHeld();
  }, HELD_CHECK_MS);
  releasing.unref();

  return {
    told: (messageId, userIds): void => {
      if (userIds.length === 0) return;
      follow(
        devicesFor(dependencies, messageId, userIds).then((devices) => {
          enqueue(devices, { messageId });
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
        while (fetching.size > 0 || running.size > 0 || waiting.length > 0) {
          await Promise.all([...fetching, ...running]);
          if (running.size === 0 && waiting.length > 0) pump();
        }
        return 'drained';
      })();
      const outcome = await Promise.race([drained, bound]);
      clearTimeout(timer);
      if (outcome === 'bound') {
        log.warn('pushes left at shutdown', { running: running.size, waiting: waiting.length });
      }
    },
  };
};
