/** Public-page metadata belongs to a readable message, never to an arbitrary proxy request. */
import { createHash } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { readMarkdown, webLinksOf } from '@purlay/markdown';
import { WebLinkPreview } from '@purlay/types';
import type { Clock } from '../../../platform/clock';
import type { Logger } from '../../../platform/logging';
import { slots } from '../../../modules/attachments/images';
import {
  checkingLookup,
  fetchExternal,
  systemResolver,
} from '../../../modules/images/fetch-external';
import { externalImageAddress, type ExternalFetch } from '../../../modules/images/proxy';
import { messageNotFound, type VisibleMessage } from '../channels/guard';
import { notHiddenBy } from '../messages/hidden';
import type { ChatDb } from '../schema';
import { previewHtml, WEB_PREVIEW_BYTES_MAX } from './web-preview-html';

const CARD_TTL_MS = 5 * 60 * 1000;
const NONE_TTL_MS = 60 * 1000;
const HELD_MAX = 12;
const Cached = Type.Union([
  Type.Object({ kind: Type.Literal('card'), card: WebLinkPreview }),
  Type.Object({ kind: Type.Literal('none') }),
]);

/** Fresh checked connection, fixed headers, no redirects, and a bounded identity-encoded HTML body. */
export const externalPageFetch: ExternalFetch = async (url) =>
  await fetchExternal(url, {
    kind: 'html',
    lookup: checkingLookup(systemResolver),
    maxBytes: WEB_PREVIEW_BYTES_MAX,
    timeoutMs: 5_000,
  });

interface Dependencies {
  readonly database: ChatDb;
  readonly clock: Clock;
  readonly log: Logger;
  readonly fetch: ExternalFetch;
  readonly appUrl: string;
}

/** Four origins per controller, eight waiting; at most twelve unique promises are retained. */
export const webPreviews = ({
  database,
  clock,
  log,
  fetch,
  appUrl,
}: Dependencies): ((found: VisibleMessage, rawUrl: string) => Promise<WebLinkPreview | null>) => {
  const slot = slots(4, 8);
  const pending = new Map<string, Promise<WebLinkPreview | null>>();
  return async (found, rawUrl) => {
    // Re-read before the cache: a hide, delete or edit after the HTTP guard must take effect too.
    const source = await database
      .selectFrom('messages')
      .select('content')
      .where('id', '=', found.messageId)
      .where('channel_id', '=', found.context.channelId)
      .where('deleted_at', 'is', null)
      .where(notHiddenBy(found.context.userId))
      .executeTakeFirst();
    if (source === undefined) throw messageNotFound();
    const url = externalImageAddress(rawUrl);
    if (url === null || !webLinksOf(readMarkdown(source.content).tree, appUrl).includes(url.href))
      return null;
    url.hash = '';
    const key = createHash('sha256')
      .update(`web-preview-v1\n${found.context.workspaceId}\n${url.href}`)
      .digest('hex');
    const cached = await database
      .selectFrom('link_previews')
      .select('payload')
      .where('url_hash', '=', key)
      .where('expires_at', '>', clock.now())
      .executeTakeFirst();
    if (cached !== undefined && Value.Check(Cached, cached.payload)) {
      return cached.payload.kind === 'card' ? cached.payload.card : null;
    }
    const existing = pending.get(key);
    if (existing !== undefined) return await existing;
    // A capacity skip has not tried the origin and must not poison the shared cache.
    if (pending.size >= HELD_MAX) return null;
    const task = slot(async () => {
      const fetched = await fetch(url);
      let card: WebLinkPreview | null = null;
      if (fetched.kind === 'bytes') card = await previewHtml(fetched.bytes, url);
      else
        log.info('public page preview unavailable', {
          workspaceId: found.context.workspaceId,
          host: url.hostname,
        });
      const now = clock.now();
      const values = {
        url_hash: key,
        url: url.href,
        payload: card === null ? { kind: 'none' } : { kind: 'card', card },
        fetched_at: now,
        expires_at: new Date(now.getTime() + (card === null ? NONE_TTL_MS : CARD_TTL_MS)),
      };
      await database
        .insertInto('link_previews')
        .values(values)
        .onConflict((conflict) => conflict.column('url_hash').doUpdateSet(values))
        .execute();
      return card;
    }).finally(() => {
      pending.delete(key);
    });
    pending.set(key, task);
    return await task;
  };
};
