/**
 * `/api/attachments/:attachmentId` (D-109 §6, #111): the bytes behind an id, brokered — never a
 * public URL — and served so that nothing in them can run on this origin.
 *
 * An image is one Purlay re-encoded (D-109 §1), so it is drawn: `inline`, as `image/webp`, whatever
 * the upload claimed. Everything else is a file to save: `attachment`, as
 * `application/octet-stream` — the stored type is never echoed, so an HTML or SVG upload cannot be
 * rendered as the document it pretends to be. Either way `nosniff`, a sandboxing policy that loads
 * nothing, and `same-origin` for who may embed it. The bytes behind an id never change and the
 * cache is the person's own, so it is cached as long as a browser will.
 */
import type { Auth } from '../../modules/auth/better-auth';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import {
  attachmentNotFound,
  requireAttachmentById,
  type ReadableAttachment,
} from '../../platform/channels';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import type { Atomically } from '../../platform/transactions';
import { discardUpload } from '../../modules/attachments/uploads';
import { requireSession } from './session';

export interface AttachmentRouteDependencies {
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
  readonly storage: ObjectStore;
}

/** The original, or an image's thumbnail. */
export type Variant = 'original' | 'thumbnail';

/** A name every browser can show: printable ASCII, no quote or backslash, for `filename=`. */
const asciiFallback = (name: string): string => name.replace(/[^\x20-\x7e]|["\\]/g, '_');

/** An image is stored as WebP, so it is saved as one, under the name it was uploaded with. */
const savedName = (attachment: ReadableAttachment): string =>
  attachment.kind === 'image'
    ? `${attachment.fileName.replace(/\.[^.]*$/, '')}.webp`
    : attachment.fileName;

/** The headers a download is served with (RFC 6266 for the name, RFC 5987 for its encoding). */
const downloadHeaders = (attachment: ReadableAttachment): Record<string, string> => {
  const image = attachment.kind === 'image';
  const name = savedName(attachment);
  return {
    'content-type': image ? 'image/webp' : 'application/octet-stream',
    'content-disposition': `${image ? 'inline' : 'attachment'}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
    'cross-origin-resource-policy': 'same-origin',
    'cache-control': 'private, max-age=31536000, immutable',
  };
};

export const downloadAttachment = async (
  dependencies: AttachmentRouteDependencies,
  request: Request,
  attachmentId: string,
  variant: Variant,
): Promise<{
  readonly body: ReadableStream<Uint8Array>;
  readonly headers: Record<string, string>;
}> => {
  const { database, storage } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const attachment = await requireAttachmentById(database, userId, attachmentId);
  const key = variant === 'original' ? attachment.storageKey : attachment.thumbnailKey;
  // A file has no thumbnail: there is nothing at that address, for anyone.
  if (key === null) throw attachmentNotFound();
  const stored = await storage.get(key);
  if (stored === null) {
    // A row whose object is gone is our failure, not the reader's: loud, never "not found".
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
  }
  return {
    body: stored.body,
    headers: { ...downloadHeaders(attachment), 'content-length': String(stored.size) },
  };
};

export const discardAttachment = async (
  dependencies: AttachmentRouteDependencies & {
    readonly atomically: Atomically;
    readonly log: Logger;
  },
  request: Request,
  attachmentId: string,
): Promise<void> => {
  const { userId } = await requireSession(dependencies.auth, request);
  await discardUpload(dependencies, userId, attachmentId);
};
