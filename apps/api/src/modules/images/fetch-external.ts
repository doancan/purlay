/**
 * Fetching an image from somebody else's server without becoming a way into ours (#110,
 * `docs/spikes/image-proxy.md`).
 *
 * - **The address connected to is the address checked.** `node:https` with a `lookup` that resolves
 *   the name, refuses it if *any* address is not public (`addresses.ts`), and answers only those it
 *   checked — Bun's `fetch` cannot be told where to connect, so it is not used. TLS still names the
 *   host and checks its certificate: the platform's own verification, nothing loosened.
 * - **A fresh connection every time** (`agent: false`): a kept-alive socket skips `lookup`, and with it
 *   the check — measured in the spike.
 * - **No redirect is followed**: anything but `200` is no image, so a `302` to an internal address
 *   leads nowhere.
 * - **Bounded**: the body is read up to `maxBytes` and refused past it; the whole exchange has
 *   `timeoutMs`. Nothing about the reader is sent — no cookie, no referrer, no credential.
 *
 * Every failure is a reason for the log and nothing more for the person: what an internal address
 * did or did not answer is exactly what an attacker would ask this for.
 */
import type { LookupFunction } from 'node:net';
import https from 'node:https';
import type http from 'node:http';
import dns from 'node:dns';
import { isPublicAddress } from './addresses';

interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** Every address a name has. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) =>
  await dns.promises.lookup(hostname, { all: true, verbatim: true });

class RefusedAddress extends Error {
  public constructor() {
    super('refused an address that is not public');
  }
}

/**
 * A `lookup` for `node:http(s)` that answers only addresses the policy allows, and refuses the name
 * outright when any address does not pass — a name that is public on one record and private on
 * another is a rebinding attempt, not a choice.
 */
export const checkingLookup =
  (resolve: Resolver, allowed: (address: string) => boolean = isPublicAddress): LookupFunction =>
  (hostname, options, callback): void => {
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (first === undefined || addresses.some((entry) => !allowed(entry.address))) {
          callback(new RefusedAddress(), '');
          return;
        }
        if (options.all === true) callback(null, [...addresses]);
        else callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)), '');
      },
    );
  };

export type Fetched =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'failed'; readonly reason: string };

export interface FetchOptions {
  readonly lookup: LookupFunction;
  /** `https` in production; a test's local server speaks `http`. */
  readonly transport?: Pick<typeof https, 'request'> | Pick<typeof http, 'request'>;
  /** 443 in production; a test's local server is elsewhere. */
  readonly port?: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export const fetchExternal = async (url: URL, options: FetchOptions): Promise<Fetched> =>
  await new Promise<Fetched>((resolve) => {
    let settled = false;
    const finish = (result: Fetched): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(result);
    };
    const request = (options.transport ?? https).request(
      {
        host: url.hostname,
        port: options.port ?? 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: options.lookup,
        agent: false,
        headers: { accept: 'image/*', 'user-agent': 'Purlay image proxy' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          finish({ kind: 'failed', reason: `answered ${String(response.statusCode)}` });
          return;
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        response.on('data', (chunk: Uint8Array) => {
          size += chunk.byteLength;
          if (size > options.maxBytes) {
            finish({ kind: 'failed', reason: `larger than ${String(options.maxBytes)} bytes` });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          // A Buffer is a Uint8Array: concatenated once, at its known size, and not copied again.
          finish({ kind: 'bytes', bytes: Buffer.concat(chunks, size) });
        });
        response.on('error', (error: Error) => {
          finish({ kind: 'failed', reason: error.message });
        });
      },
    );
    const timer = setTimeout(() => {
      finish({ kind: 'failed', reason: `took longer than ${String(options.timeoutMs)} ms` });
    }, options.timeoutMs);
    request.on('error', (error: Error) => {
      finish({ kind: 'failed', reason: error.message });
    });
    request.end();
  });

export type Posted =
  | { readonly kind: 'answered'; readonly status: number }
  | { readonly kind: 'failed'; readonly reason: string };

/**
 * A POST to somebody else's server on the same terms as a fetch: the checked address, a fresh
 * connection, nothing about the sender but what is given, no redirect followed, bounded in time. The
 * answer is its status alone — the body is not read, so a server cannot make this hold memory.
 * Web Push sends through it (D-126 §6).
 */
export const postExternal = async (
  url: URL,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array,
  options: Omit<FetchOptions, 'maxBytes'>,
): Promise<Posted> =>
  await new Promise<Posted>((resolve) => {
    let settled = false;
    const finish = (result: Posted): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(result);
    };
    const request = (options.transport ?? https).request(
      {
        host: url.hostname,
        port: options.port ?? 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        lookup: options.lookup,
        agent: false,
        headers: { ...headers, 'content-length': String(body.byteLength) },
      },
      (response) => {
        finish({ kind: 'answered', status: response.statusCode ?? 0 });
      },
    );
    const timer = setTimeout(() => {
      finish({ kind: 'failed', reason: `took longer than ${String(options.timeoutMs)} ms` });
    }, options.timeoutMs);
    request.on('error', (error: Error) => {
      finish({ kind: 'failed', reason: error.message });
    });
    request.end(body);
  });
