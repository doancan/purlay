/** The APNs provider protocol, with a signing key and a fixed Apple host for one app. */
import { importPKCS8, SignJWT } from 'jose';
import type { PushPayload } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { PushOutcome } from './queue-result';

const ORIGINS = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
} as const;
// Apple accepts a provider token for one hour and permits updates at least twenty minutes apart.
const TOKEN_AGE_SECONDS = 45 * 60;
const TIMEOUT_MS = 5_000;
const PAYLOAD_MAX_BYTES = 4_096;
const RESPONSE_MAX_BYTES = 1_024;

interface ApnsCredentials {
  readonly environment: keyof typeof ORIGINS;
  readonly topic: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly signingKey: string;
}

interface ApnsPush {
  readonly deviceToken: string;
  readonly payload: PushPayload;
  readonly expiresAt: Date;
  /** A durable delivery identifier shared by its retries, at most 64 ASCII bytes. */
  readonly collapseId: string;
}

type ApnsOutcome =
  | Exclude<PushOutcome, { readonly kind: 'held' }>
  | { readonly kind: 'unregistered'; readonly status: 410; readonly invalidatedAt?: number };

type ApnsFetch = (url: URL, options: BunFetchRequestInit) => Promise<Response>;

/** Opaque, variable-length bytes represented as a single hexadecimal URL segment. */
export const normalizeApnsToken = (token: string): string | undefined =>
  /^(?:[0-9a-fA-F]{2}){1,256}$/.test(token) ? token.toLowerCase() : undefined;

/** APNs timestamps invalidations so an old response need not retire a newer registration. */
const invalidatedAt = async (body: ReadableStream<Uint8Array>): Promise<number | undefined> => {
  const bytes = new Uint8Array(RESPONSE_MAX_BYTES);
  const reader = body.getReader();
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > bytes.length) return undefined;
      bytes.set(value, length);
      length += value.byteLength;
    }
    const reply: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    if (reply === null || typeof reply !== 'object' || !('timestamp' in reply)) return undefined;
    const stamp = reply.timestamp;
    return typeof stamp === 'number' && Number.isSafeInteger(stamp) && stamp >= 0
      ? stamp
      : undefined;
  } catch {
    return undefined;
  } finally {
    await reader.cancel();
  }
};

export const createApnsProvider = async (
  credentials: ApnsCredentials,
  clock: Clock,
  post: ApnsFetch = fetch,
): Promise<(push: ApnsPush) => Promise<ApnsOutcome>> => {
  const { environment, topic, teamId, keyId } = credentials;
  if (!/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId))
    throw new Error('APNs requires a ten-character team ID and key ID');
  if (!/^[A-Za-z0-9.-]{1,255}$/.test(topic)) throw new Error('APNs requires a valid app topic');
  const origin = ORIGINS[environment];
  const signingKey = await importPKCS8(credentials.signingKey, 'ES256');
  let cached: { readonly issuedAt: number; readonly bearer: Promise<string> } | undefined;

  const bearerAt = async (issuedAt: number): Promise<string> => {
    if (cached === undefined || issuedAt - cached.issuedAt >= TOKEN_AGE_SECONDS) {
      cached = {
        issuedAt,
        bearer: new SignJWT({})
          .setProtectedHeader({ alg: 'ES256', kid: keyId })
          .setIssuer(teamId)
          .setIssuedAt(issuedAt)
          .sign(signingKey),
      };
    }
    const token = cached;
    try {
      return `bearer ${await token.bearer}`;
    } catch (error) {
      if (cached === token) cached = undefined;
      throw error;
    }
  };

  return async ({ deviceToken, payload, expiresAt, collapseId }) => {
    const now = Math.floor(clock.now().getTime() / 1_000);
    const expires = Math.floor(expiresAt.getTime() / 1_000);
    if (!Number.isFinite(expires) || expires <= now) return { kind: 'canceled' };
    const token = normalizeApnsToken(deviceToken);
    if (token === undefined || !/^[!-~]{1,64}$/.test(collapseId)) return { kind: 'refused' };
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        ...(payload.silent === true ? {} : { sound: 'default' }),
      },
      url: payload.url,
      tag: payload.tag,
    });
    if (Buffer.byteLength(body) > PAYLOAD_MAX_BYTES) return { kind: 'refused' };

    const authorization = await bearerAt(now);
    try {
      const response = await post(new URL(`/3/device/${token}`, origin), {
        method: 'POST',
        protocol: 'http2',
        redirect: 'manual',
        proxy: false,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          authorization,
          'apns-topic': topic,
          'apns-push-type': 'alert',
          'apns-collapse-id': collapseId,
          'apns-expiration': String(expires),
          'content-type': 'application/json',
        },
        body,
      });
      const { status } = response;
      if (status === 410) {
        const stamp = response.body === null ? undefined : await invalidatedAt(response.body);
        return {
          kind: 'unregistered',
          status,
          ...(stamp === undefined ? {} : { invalidatedAt: stamp }),
        };
      }
      await response.body?.cancel();
      if (status === 200) return { kind: 'delivered', status };
      if (status >= 300 && status < 500 && status !== 429) return { kind: 'refused', status };
      const retryAfter = response.headers.get('retry-after');
      return { kind: 'retry', status, ...(retryAfter === null ? {} : { retryAfter }) };
    } catch {
      // Avoid propagating an error message that may include the private device URL.
      return { kind: 'retry' };
    }
  };
};
