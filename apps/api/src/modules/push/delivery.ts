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
import type { EntitlementPolicy } from '../../platform/module-kit/entitlement';
import type { Logger } from '../../platform/logging';
import type { Posted } from '../images/fetch-external';
import { externalImageAddress } from '../images/proxy';
import { inDeepWork } from '../workspaces/deep-work';
import type { Device, PushKeys } from './devices';
import { encryptPush, freshParts } from './encrypt';
import type { FailureCount } from './failures';
import type { PushNotices } from './notices';
import { vapidAuthorization, vapidSigningKey } from './vapid';
import { beginPushAttempt, ownsPushClaim, type PushClaim } from './queue';
import { currentPushDevice, currentPushSource } from './authority';
import { applyPushResponse } from './response';
import type { PushOutcome } from './queue-result';

/** The largest recorded failure streak; temporary failures never expire a subscription. */
export const PUSH_FAILURES_MAX = 5;
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
  readonly effectiveModules: EntitlementPolicy['effective'];
}

interface DeliveryOptions {
  readonly failed: FailureCount;
}

export const createDelivery = async (
  dependencies: DeliveryDependencies,
  { failed }: DeliveryOptions,
): Promise<(device: Device, claim: PushClaim) => Promise<PushOutcome>> => {
  const { database, clock, log, keys, post } = dependencies;
  // Imported once, here, so a key that cannot sign stops the start rather than the first push.
  let cached: { readonly publicKey: string; readonly signing: CryptoKey } | undefined;
  if (typeof keys !== 'function')
    cached = { publicKey: keys.publicKey, signing: await vapidSigningKey(keys) };

  const forget = async (device: Device, claim: PushClaim): Promise<boolean> =>
    await applyPushResponse(database, clock, claim, device, async (tx) => {
      await tx
        .deleteFrom('push_subscriptions')
        .where('id', '=', device.id)
        .where('user_id', '=', device.userId)
        .where('session_id', '=', device.sessionId)
        .where('generation', '=', device.generation)
        .execute();
    });

  const counted = async (
    device: Device,
    url: URL,
    posted: Posted,
    claim: PushClaim,
  ): Promise<boolean> => {
    const applied = await applyPushResponse(database, clock, claim, device, async (tx) => {
      await tx
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
        .where('generation', '=', device.generation)
        .execute();
    });
    if (!applied) return false;
    const said = {
      host: url.hostname,
      ...(posted.kind === 'answered' ? { status: posted.status } : { reason: 'network' }),
    };
    failed('not_taken', 1, device.module);
    log.warn('push not taken', said);
    return true;
  };

  const quiet = async (device: Device): Promise<boolean> =>
    (await inDeepWork(database, device.workspaceId, [device.userId], clock.now())).has(
      device.userId,
    );

  return async (device, claim) => {
    const url = externalImageAddress(device.endpoint);
    if (url === null) {
      log.info('push device forgotten', { reason: 'not an address push may reach' });
      return { kind: (await forget(device, claim)) ? 'canceled' : 'retry' };
    }
    const first = await currentPushDevice(dependencies, claim);
    if (first === undefined || !(await currentPushSource(dependencies, claim)))
      return { kind: 'canceled' };
    if (dependencies.attention.active(device.userId, device.workspaceId))
      return { kind: 'canceled' };
    if (await quiet(device)) return { kind: 'held' };
    const current = typeof keys === 'function' ? await keys() : keys;
    if (current?.publicKey !== device.serverKey) return { kind: 'canceled' };
    if (!(await beginPushAttempt(database, claim, clock.now(), device.serverKey)))
      return { kind: 'canceled' };
    const sound = first.sound;
    const body = await encryptPush(
      device,
      new TextEncoder().encode(JSON.stringify({ ...device.payload, silent: !sound })),
      await freshParts(),
    );
    if (cached?.publicKey !== current.publicKey)
      cached = { publicKey: current.publicKey, signing: await vapidSigningKey(current) };
    const authorization = await vapidAuthorization(
      cached.signing,
      current,
      device.endpoint,
      clock.now(),
    );
    const live = await currentPushDevice(dependencies, claim);
    if (live === undefined) return { kind: 'canceled' };
    // Rebuild a changed sound preference on the next attempt; never post the stale prepared body.
    if (live.sound !== sound) return { kind: 'retry' };
    if (!(await currentPushSource(dependencies, claim))) return { kind: 'canceled' };
    if (dependencies.attention.active(device.userId, device.workspaceId))
      return { kind: 'canceled' };
    if (await quiet(device)) return { kind: 'held' };
    if (typeof keys === 'function' && (await keys())?.publicKey !== device.serverKey)
      return { kind: 'canceled' };
    const topic = Buffer.from(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${claim.intentId}:${claim.subscriptionId}:${claim.generation}`),
      ),
    )
      .toString('base64url')
      .slice(0, 32);
    if (!(await ownsPushClaim(database, claim, clock.now(), device.serverKey)))
      return { kind: 'canceled' };
    const ttl = Math.floor((claim.expiresAt.getTime() - clock.now().getTime()) / 1_000);
    if (ttl <= 0) return { kind: 'canceled' };
    const posted = await post(
      url,
      {
        authorization,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(ttl),
        topic,
        urgency: 'high',
      },
      body,
    );
    if (!(await ownsPushClaim(database, claim, clock.now(), device.serverKey)))
      return { kind: 'canceled' };
    const status = posted.kind === 'answered' ? posted.status : null;
    if (status !== null && status >= 200 && status < 300) {
      const applied = await applyPushResponse(database, clock, claim, device, async (tx) => {
        await tx
          .updateTable('push_subscriptions')
          .set({ failures: 0 })
          .where('id', '=', device.id)
          .where('user_id', '=', device.userId)
          .where('session_id', '=', device.sessionId)
          .where('generation', '=', device.generation)
          .where('failures', '>', 0)
          .execute();
      });
      return applied ? { kind: 'delivered', status } : { kind: 'retry' };
    }
    if (status === 404 || status === 410) {
      log.info('push device forgotten', { host: url.hostname, status });
      return (await forget(device, claim))
        ? { kind: 'canceled', status }
        : { kind: 'retry', status };
    }
    if (status !== null && OUR_REQUEST_REFUSED.has(status)) {
      // The keys, the token or the body: this server's to fix, not the browser's to pay for.
      failed('refused', 1, device.module);
      log.error('push refused: this server’s request', { host: url.hostname, status });
      return { kind: 'refused', status };
    }
    if (!(await counted(device, url, posted, claim))) return { kind: 'retry' };
    return {
      kind: 'retry',
      ...(status !== null && status >= 100 && status <= 599 ? { status } : {}),
      ...(posted.kind === 'answered' && posted.retryAfter !== undefined
        ? { retryAfter: posted.retryAfter }
        : {}),
    };
  };
};
