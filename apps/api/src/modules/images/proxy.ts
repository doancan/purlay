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
 * - **One answer for every failure**, `404 IMAGE_NOT_AVAILABLE`: refused, unreachable, not an image,
 *   too large and too busy to decode now look the same from outside, and the reason is in the log
 *   with the host alone — the rest of an address may carry somebody's token.
 */
import { isIP } from 'node:net';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { SlotsFull, readImage, slots, type OpenImage } from '../attachments/images';
import { checkingLookup, fetchExternal, systemResolver, type Fetched } from './fetch-external';

/** How much of an external image is read before it is refused. */
const EXTERNAL_IMAGE_BYTES_MAX = 10 * 1024 * 1024;
/** How long its server has to send it all. */
const EXTERNAL_IMAGE_TIMEOUT_MS = 5_000;

/**
 * The proxy's share of the node's decodes (D-170): one at a time, four waiting — a round of the
 * route's four fetches finishing together. The node has two decode slots; holding at most one, a feed
 * full of pictures can never keep an upload waiting behind it. Past the line, the picture is not
 * available now, like any other failure.
 */
const decoding = slots(1, 4);

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
  /** How a fetched image is opened; `Bun.Image` unless a test holds its decodes. */
  readonly open?: OpenImage;
}

/** The image at the address, re-encoded as WebP; or the one refusal. */
export const proxyImage = async (
  { fetch, log, open }: ProxyDependencies,
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
    image = await decoding(async () => await readImage(fetched.bytes, open));
  } catch (error) {
    if (error instanceof SlotsFull) {
      log.info('external image not decoded', { host: url.hostname, reason: error.message });
      throw notAvailable();
    }
    // The decoder's own refusals (too large, unreadable, the node's decode line full) are the image's;
    // anything else is ours and is a 500 — it says something about a public image and our decoder,
    // nothing about the network.
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
