/**
 * `GET /api/images?url=` — an image on another server, through the proxy (#110): signed in, so the
 * API is not anybody's open proxy; a few at a time per node, so a feed full of pictures cannot hold
 * every connection; and served as an image of ours, with the headers a download has.
 */
import type { Executor } from '@purlay/db';
import { ExternalImageQuery } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { SlotsFull, slots } from '../../modules/attachments/images';
import { proxyImage, type ExternalFetch } from '../../modules/images/proxy';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/** External images fetched at once on one node; the rest wait their turn, a bounded line of them. */
const FETCHES_AT_ONCE = 4;
/**
 * Waiting for a fetch slot, per node. Each fetch may take five seconds, so a longer line is a wait
 * nobody would sit through; past it a picture is not available now, like any other failure.
 */
export const FETCHES_WAITING = 16;
const fetching = slots(FETCHES_AT_ONCE, FETCHES_WAITING);

export interface ImageRouteDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly externalFetch: ExternalFetch;
}

export const serveExternalImage = async (
  { database, clock, log, externalFetch }: ImageRouteDependencies,
  request: Request,
): Promise<{ readonly body: Uint8Array; readonly headers: Record<string, string> }> => {
  await requireSession(database, clock, request);
  const { url } = validated(ExternalImageQuery, queryOf(new URL(request.url)));
  // Only the fetch holds a slot: a slow server keeps its own turn, not a decode's as well (#110 review).
  const fetch: ExternalFetch = async (address) =>
    await fetching(async () => await externalFetch(address)).catch((error: unknown) => {
      if (error instanceof SlotsFull) return { kind: 'failed' as const, reason: error.message };
      throw error;
    });
  const body = await proxyImage({ fetch, log }, url);
  return {
    body,
    headers: {
      'content-type': 'image/webp',
      'content-length': String(body.byteLength),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
      'cross-origin-resource-policy': 'same-origin',
      // The reader's own copy for a day: the image may change at its source, and is asked for again.
      'cache-control': 'private, max-age=86400',
    },
  };
};
