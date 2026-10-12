/**
 * An image on another server, shown without telling that server who is reading (#110,
 * `ARCHITECTURE.md` §8.1): the API fetches it, as itself, and hands the reader its own re-encoding.
 *
 * - **Only an `https` address on its usual port, naming a host** — no address literal, no
 *   credentials, nothing local. A literal would skip the checking `lookup` entirely, and an image on
 *   the internet has a name.
 * - **Fetched by `fetch-external.ts`**: the checked address, a fresh connection, no redirect, a cap
 *   and a clock.
 * - **Re-encoded** (`images.ts`): decoded within the attachment bounds and written as WebP, so what the
 *   reader gets is our bytes — never the origin's, its headers or its EXIF.
 * - **One answer for every failure**, `404 IMAGE_NOT_AVAILABLE`: refused, unreachable, not an image
 *   and too large look the same from outside, and the reason is in the log with the host alone — the
 *   rest of an address may carry somebody's token.
 */
import { isIP } from 'node:net';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { readImage } from '../attachments/images';
import { checkingLookup, fetchExternal, systemResolver, type Fetched } from './fetch-external';

/** How much of an external image is read before it is refused. */
const EXTERNAL_IMAGE_BYTES_MAX = 10 * 1024 * 1024;
/** How long its server has to send it all. */
const EXTERNAL_IMAGE_TIMEOUT_MS = 5_000;

export type ExternalFetch = (url: URL) => Promise<Fetched>;

/** The production fetch: the system's resolver, the public-address policy, the bounds above. */
export const externalFetch: ExternalFetch = async (url) =>
  await fetchExternal(url, {
    lookup: checkingLookup(systemResolver),
    timeoutMs: EXTERNAL_IMAGE_TIMEOUT_MS,
    maxBytes: EXTERNAL_IMAGE_BYTES_MAX,
  });

const notAvailable = (): AppError =>
  new AppError({ code: 'IMAGE_NOT_AVAILABLE', message: 'That image cannot be shown here.' });

/** The address, if it is one the proxy may try: https, the usual port, a name, no credentials. */
export const externalImageAddress = (raw: string): URL | null => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || !host.includes('.');
  // `URL` keeps an IPv6 literal in brackets; `isIP` is asked about what is inside them.
  const literal = isIP(host.replace(/^\[|\]$/g, '')) !== 0;
  const usable =
    url.protocol === 'https:' &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    !literal &&
    !local;
  return usable ? url : null;
};

export interface ProxyDependencies {
  readonly fetch: ExternalFetch;
  readonly log: Logger;
}

/** The image at the address, re-encoded as WebP; or the one refusal. */
export const proxyImage = async (
  { fetch, log }: ProxyDependencies,
  raw: string,
): Promise<Uint8Array> => {
  const url = externalImageAddress(raw);
  if (url === null) {
    log.info('external image refused', { reason: 'not an https address on a named host' });
    throw notAvailable();
  }
  const fetched = await fetch(url);
  if (fetched.kind === 'failed') {
    log.info('external image not fetched', { host: url.hostname, reason: fetched.reason });
    throw notAvailable();
  }
  let image: Awaited<ReturnType<typeof readImage>>;
  try {
    image = await readImage(fetched.bytes);
  } catch (error) {
    // The decoder's own refusals (too large, unreadable) are the image's; anything else is ours and is
    // a 500 — it says something about a public image and our decoder, nothing about the network.
    if (!(error instanceof AppError)) throw error;
    log.info('external image not readable', { host: url.hostname, reason: error.body.code });
    throw notAvailable();
  }
  if (image === null) {
    log.info('external image not an image', { host: url.hostname });
    throw notAvailable();
  }
  return image.bytes;
};
