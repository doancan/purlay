/**
 * Delivering one push to one device (#78, D-126): ask again, right before, whether the device is still the
 * person's and the notice still theirs; encrypt it, sign it with the server's key, post it to the push
 * service the browser named, and act on the answer — 2xx keeps the device; 404 or 410 forgets it (the
 * browser dropped it); 400, 401, 403 or 413 is this server's request refused, said loudly and no device's
 * fault; any other answer, a timeout or a network failure records a bounded failure streak without
 * confusing a provider outage with the browser unsubscribing.
 */
import type { Executor } from '@purlay/db';
import type { Attention } from '../../platform/attention';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { Posted } from '../images/fetch-external';
import { externalImageAddress } from '../images/proxy';
import { inDeepWork } from '../workspaces/deep-work';
import type { Device, PushKeys } from './devices';
import { encryptPush, freshParts } from './encrypt';
import type { FailureCount } from './failures';
import type { PushNotices } from './notices';
import { vapidAuthorization, vapidSigningKey } from './vapid';

/** The largest recorded failure streak; temporary failures never expire a subscription. */
export const PUSH_FAILURES_MAX = 5;
/** How long a push service keeps it for a device that is off: a day, then it is stale. */
export const PUSH_TTL_SECONDS = 24 * 60 * 60;

/** The answers that are this server's request refused, not the device's absence. */
const OUR_REQUEST_REFUSED = new Set([400, 401, 403, 413]);

export type PushPost = (
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
) => Promise<Posted>;

interface DeliveryDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly keys: PushKeys;
  readonly post: PushPost;
  readonly attention: Attention;
  readonly notices: PushNotices;
}

interface DeliveryOptions {
  readonly failed: FailureCount;
  /** Holds a module's notice (by its entry) because its person went into Deep Work while the push waited. */
  readonly hold: (entryId: string, now: number, deviceId: string) => void;
}

export const createDelivery = async (
  dependencies: DeliveryDependencies,
  { failed, hold }: DeliveryOptions,
): Promise<(device: Device) => Promise<void>> => {
  const { database, clock, log, keys, post } = dependencies;
  // Imported once, here, so a key that cannot sign stops the start rather than the first push.
  let cached: { readonly publicKey: string; readonly signing: CryptoKey } | undefined;
  if (typeof keys !== 'function')
    cached = { publicKey: keys.publicKey, signing: await vapidSigningKey(keys) };

  const forget = async (device: Device): Promise<void> => {
    await database
      .deleteFrom('push_subscriptions')
      .where('id', '=', device.id)
      .where('user_id', '=', device.userId)
      .where('session_id', '=', device.sessionId)
      .execute();
  };

  /** Still the person's, in a live session: asked right before the push goes. */
  const stillTheirs = async (device: Device): Promise<{ readonly sound: boolean } | undefined> =>
    await database
      .selectFrom('push_subscriptions as s')
      .innerJoin('sessions as live', 'live.id', 's.session_id')
      .select('s.sound')
      .where('s.id', '=', device.id)
      .where('s.user_id', '=', device.userId)
      .where('s.session_id', '=', device.sessionId)
      .where('live.expires_at', '>', clock.now())
      .executeTakeFirst();

  const counted = async (device: Device, url: URL, posted: Posted): Promise<void> => {
    await database
      .updateTable('push_subscriptions')
      .set((eb) => ({
        failures: eb(
          eb.fn<number>('least', [eb.ref('failures'), eb.val(PUSH_FAILURES_MAX - 1)]),
          '+',
          1,
        ),
      }))
      .where('id', '=', device.id)
      .where('user_id', '=', device.userId)
      .where('session_id', '=', device.sessionId)
      .execute();
    const said = {
      host: url.hostname,
      ...(posted.kind === 'answered' ? { status: posted.status } : { reason: posted.reason }),
    };
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

  return async (device) => {
    const url = externalImageAddress(device.endpoint);
    if (url === null) {
      log.info('push device forgotten', { reason: 'not an address push may reach' });
      await forget(device);
      return;
    }
    const sound = (await stillTheirs(device))?.sound ?? false;
    const body = await encryptPush(
      device,
      new TextEncoder().encode(JSON.stringify({ ...device.payload, silent: !sound })),
      await freshParts(),
    );
    const current = typeof keys === 'function' ? await keys() : keys;
    if (current?.publicKey !== device.serverKey) return;
    if (cached?.publicKey !== current.publicKey)
      cached = { publicKey: current.publicKey, signing: await vapidSigningKey(current) };
    const authorization = await vapidAuthorization(
      cached.signing,
      current,
      device.endpoint,
      clock.now(),
    );
    const live = await stillTheirs(device);
    if (live === undefined) return;
    // Changed while encryption waited: retire this prepared alert, just as a page retires a stale card.
    if (live.sound !== sound) return;
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
    if (typeof keys === 'function' && (await keys())?.publicKey !== device.serverKey) return;
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
        .where('user_id', '=', device.userId)
        .where('session_id', '=', device.sessionId)
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
};
