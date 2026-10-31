/**
 * Telling a person's devices what needs them, after the write that decided it has committed
 * (#78, D-126).
 *
 * - **Who:** only the people a write told for the first time (`notify` returns them), and of those
 *   only a notification still unread, not held back by Deep Work, of a reason that needs them, on a
 *   message not deleted — on a device whose session is live and whose subscription was made with the
 *   server's current key. Looked up once per write, and each device is asked again, by its owner
 *   and session, right before it is sent to: a browser signed out of in between is not told. Pushed
 *   by the node that committed, never through the bus: a second node does not push it twice (§8).
 * - **What:** who and why, in the person's language (`words.ts`) and where, never what was written.
 * - **Where it goes:** the push service the browser named, through the checked address and lookup an
 *   external image uses (§6).
 * - **What the answer does:** 2xx keeps the device; 404 or 410 forgets it (the browser dropped it);
 *   400, 401, 403 or 413 is this server's request refused — said loudly, and no device's fault; any
 *   other answer, a timeout or a network failure counts against the device, and `PUSH_FAILURES_MAX`
 *   in a row forgets it.
 * - **Detached, bounded and fair:** the write's caller does not wait. At most `POSTS_AT_ONCE` are in
 *   flight on the node and `POSTS_PER_PERSON` for any one person, so one person's slow or hostile
 *   push services cannot hold everybody else's; past `QUEUE_MAX` waiting, a push is dropped and
 *   said. `flush` waits for them at shutdown, within its bound.
 */
import { sql, type Executor } from '@purlay/db';
import { NEEDS_YOU, type PushPayload } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Attention } from '../../platform/attention';
import type { Logger } from '../../platform/logging';
import type { Counter, PushFailure } from '../../platform/metrics';
import type { Posted } from '../images/fetch-external';
import { externalImageAddress } from '../images/proxy';
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

export type PushPost = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
) => Promise<Posted>;

export interface PushSender {
  /** The people `messageId` told for the first time; returns at once. */
  readonly told: (messageId: string, userIds: readonly string[]) => void;
  /** Waits for every push on its way, `boundMs` at most, and says what it left. */
  readonly flush: (boundMs?: number) => Promise<void>;
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
  /** Where a push that did not reach its service is counted, by why (D-221); absent, it is not. */
  readonly failures?: Counter<'reason'>;
}

interface Device {
  readonly id: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly payload: PushPayload;
}

/** The answers that are this server's request refused, not the device's absence. */
const OUR_REQUEST_REFUSED = new Set([400, 401, 403, 413]);

const devicesFor = async (
  { database, clock, keys, attention, log }: PushSenderDependencies,
  messageId: string,
  userIds: readonly string[],
): Promise<Device[]> => {
  const rows = await database
    .selectFrom('notifications as n')
    .innerJoin('messages as m', 'm.id', 'n.message_id')
    .innerJoin('users as author', 'author.id', 'm.sender_id')
    .innerJoin('users as person', 'person.id', 'n.user_id')
    .innerJoin('channels as c', 'c.id', 'n.channel_id')
    .innerJoin('workspaces as w', 'w.id', 'n.workspace_id')
    .innerJoin('push_subscriptions as s', 's.user_id', 'n.user_id')
    .innerJoin('sessions as live', 'live.id', 's.session_id')
    // A reply's root: whose thread it is decides what the reply is said as (D-162).
    .leftJoin('messages as root', 'root.id', 'm.parent_id')
    .select([
      's.id',
      's.user_id as userId',
      's.session_id as sessionId',
      's.endpoint',
      's.p256dh',
      's.auth',
      'n.type',
      'n.channel_id',
      'n.workspace_id',
      'person.locale',
      'author.display_name',
      'c.name',
      'w.slug',
      'root.sender_id as root_sender_id',
      // A group's people besides the one told, by name: what its notice is titled (D-127).
      sql<string | null>`(
        select string_agg(other.display_name, ', ' order by key_part.place)
        from unnest(string_to_array(c.dm_key, ':')) with ordinality as key_part(id, place)
        join users as other on other.id = key_part.id::uuid
        where cardinality(string_to_array(c.dm_key, ':')) > 2 and other.id <> n.user_id
      )`.as('group_names'),
    ])
    .where('n.message_id', '=', messageId)
    .where('n.user_id', 'in', userIds)
    .where('n.type', 'in', NEEDS_YOU)
    .where('n.read_at', 'is', null)
    .where('n.suppressed_by_deep_work', '=', false)
    .where('m.deleted_at', 'is', null)
    .where('person.deleted_at', 'is', null)
    .where('live.expires_at', '>', clock.now())
    .where('s.server_key', '=', keys.publicKey)
    // A person's devices in the order they were subscribed: the same order every time.
    .orderBy('s.created_at')
    .orderBy('s.id')
    .execute();
  const held = new Set<string>();
  const devices = rows.flatMap((row) => {
    const reason = NEEDS_YOU.find((known) => known === row.type);
    if (reason === undefined) return [];
    // In front of this workspace's page: held, never sent later (D-143, D-12).
    if (attention.active(row.userId, row.workspace_id)) {
      held.add(row.userId);
      return [];
    }
    return [
      {
        ...row,
        payload: {
          // A channel by its name; a group by its people; a direct message by who wrote it.
          title: row.name !== null ? `#${row.name}` : (row.group_names ?? row.display_name),
          body: pushBody(
            row.locale === 'tr' ? 'tr' : 'en',
            saidOf(reason, row.group_names !== null, row.root_sender_id, row.userId),
            row.display_name,
          ),
          url: `/w/${row.slug}/c/${row.channel_id}`,
          tag: `channel:${row.channel_id}`,
        },
      },
    ];
  });
  if (held.size > 0) log.debug('push held: the person is active', { messageId, people: held.size });
  return devices;
};

export const createPushSender = async (
  dependencies: PushSenderDependencies,
): Promise<PushSender> => {
  const { database, clock, log, keys, post } = dependencies;
  const failed = (reason: PushFailure, by = 1): void => {
    dependencies.failures?.inc({ reason }, by);
  };
  // Imported once, here, so a key that cannot sign stops the start rather than the first push.
  const signing = await vapidSigningKey(keys);
  const waiting: Device[] = [];
  const active = new Map<string, number>();
  const running = new Set<Promise<void>>();
  const fetching = new Set<Promise<void>>();

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
    failed('not_taken');
    log.warn('push not taken', said);
  };

  const deliver = async (device: Device): Promise<void> => {
    const url = externalImageAddress(device.endpoint);
    if (url === null) {
      log.info('push device forgotten', { reason: 'not an address push may reach' });
      await forget(device);
      return;
    }
    if (!(await stillTheirs(device))) return;
    const body = await encryptPush(
      device,
      new TextEncoder().encode(JSON.stringify(device.payload)),
      await freshParts(),
    );
    const posted = await post(
      url,
      {
        authorization: await vapidAuthorization(signing, keys, device.endpoint, clock.now()),
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
      failed('refused');
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
          failed('error');
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
    told: (messageId, userIds): void => {
      if (userIds.length === 0) return;
      const found = devicesFor(dependencies, messageId, userIds)
        .then((devices) => {
          const room = QUEUE_MAX - waiting.length;
          if (devices.length > room) {
            failed('dropped', devices.length - Math.max(room, 0));
            log.warn('push dropped: too many waiting', {
              messageId,
              dropped: devices.length - Math.max(room, 0),
            });
          }
          waiting.push(...devices.slice(0, Math.max(room, 0)));
          pump();
        })
        .catch((error: unknown) => {
          failed('error');
          log.error('push delivery failed', { messageId, stage: 'finding devices', err: error });
        })
        .finally(() => {
          fetching.delete(found);
        });
      fetching.add(found);
    },
    flush: async (boundMs = FLUSH_BOUND_MS): Promise<void> => {
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
