/**
 * What an uploaded image becomes (D-16, D-109 §1, §2), with `Bun.Image` and nothing installed
 * (`docs/spikes/image-pipeline.md`).
 *
 * **Recognised by its bytes**, never by the name or the declared type: PNG, JPEG, GIF and WebP — the
 * formats a browser draws and the built-in decodes on every platform. Anything else, SVG included, is
 * not an image here and is stored as a file.
 *
 * **Bounded before it is decoded.** The header is read with `maxPixels` at the bound, so a file that
 * claims a huge canvas is refused before a pixel buffer exists; a side past the bound is refused too.
 * At most `DECODES_AT_ONCE` decodes run per node: one 40-million-pixel re-encode peaked at +118 MiB
 * RSS, two at +258 MiB, four at +450 MiB (measured 2026-10-12, Bun 1.4.2, macOS arm64). At most
 * `DECODES_WAITING` wait for them; past that a decode is refused at once as `RATE_LIMITED`, the server
 * busy, rather than joining a line that only grows (D-170).
 *
 * **Stored re-encoded.** Turned upright (EXIF orientation), fitted inside `IMAGE_LONGEST_SIDE` without
 * stretching and never enlarged, written as WebP — which leaves every EXIF field behind (GPS, camera
 * serial) — with a thumbnail fitted inside `THUMBNAIL_SIDE`. A file whose header reads and whose pixels
 * do not is refused, not stored broken.
 */
import { ATTACHMENT_PIXELS_MAX, ATTACHMENT_SIDE_MAX } from '@purlay/types';
import { AppError } from '../../platform/errors';

export const IMAGE_LONGEST_SIDE = 2560;
export const THUMBNAIL_SIDE = 512;
const DECODES_AT_ONCE = 2;
/**
 * Waiting for a decode slot, per node (D-170). A decode at the pixel bound takes about 290 ms, so the
 * last of eight waits about a second and a quarter — as long as an upload should sit before it is told
 * the server is busy. It is above what today's callers can make wait at once (four uploads per node,
 * and the image proxy's one decode at a time), so it refuses only a caller that has lost its own gate.
 */
const DECODES_WAITING = 8;

export interface ReadImage {
  readonly bytes: Uint8Array;
  readonly thumbnail: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0): boolean =>
  prefix.every((byte, index) => bytes[at + index] === byte);

/** PNG, JPEG, GIF or WebP, by their signatures. */
const isOurImage = (bytes: Uint8Array): boolean =>
  startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
  startsWith(bytes, [0xff, 0xd8, 0xff]) ||
  startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
  (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8));

const tooLarge = (): AppError =>
  new AppError({
    code: 'IMAGE_TOO_LARGE',
    message: 'That image has more pixels than Purlay takes.',
  });

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;

/** Every slot is taken and the line for them is as long as it may be: nothing was run. */
export class SlotsFull extends Error {
  public constructor() {
    super('every slot is taken and the queue for them is full');
  }
}

/**
 * At most `limit` jobs at once; the rest wait their turn, in order, at most `maxWaiting` of them — a
 * job past that is refused at once with `SlotsFull`, so a line that only grows cannot hold every
 * caller's connection (found by review, for the image proxy). A freed slot is handed to the next
 * waiter rather than given back: given back, a newcomer arriving before the waiter wakes takes it
 * too, and one more runs than the limit.
 */
export const slots = (
  limit: number,
  maxWaiting = Number.POSITIVE_INFINITY,
): (<T>(work: () => Promise<T>) => Promise<T>) => {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= limit) {
      if (waiting.length >= maxWaiting) throw new SlotsFull();
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    } else {
      running += 1;
    }
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next === undefined) running -= 1;
      else next();
    }
  };
};

/** The node's decode slots, and the bounded line for them. */
const slot = slots(DECODES_AT_ONCE, DECODES_WAITING);

const busy = (): AppError =>
  new AppError({
    code: 'RATE_LIMITED',
    message: 'This server is reading as many images as it can. Try again in a moment.',
  });

/** How an image is opened: `Bun.Image`, or a stand-in that fails where a test needs it to. */
export type OpenImage = (bytes: Uint8Array, options?: { maxPixels: number }) => Bun.Image;

const openImage: OpenImage = (bytes, options) => new Bun.Image(bytes, options);

/**
 * The image, re-encoded with its thumbnail; or null when the bytes are not one of the four formats.
 * Only the decoder's own refusals are the sender's fault; anything else is ours, and is thrown as it is.
 */
export const readImage = async (
  bytes: Uint8Array,
  open: OpenImage = openImage,
): Promise<ReadImage | null> => {
  if (!isOurImage(bytes)) return null;
  // Bytes, never a string: a string is read by `Bun.Image` as a path on disk.
  const source = (): Bun.Image => open(bytes, { maxPixels: ATTACHMENT_PIXELS_MAX });
  try {
    const header = await source().metadata();
    if (header.width > ATTACHMENT_SIDE_MAX || header.height > ATTACHMENT_SIDE_MAX) throw tooLarge();
    return await slot(async () => {
      const fitted = (side: number): Promise<Uint8Array> =>
        source()
          .resize(side, side, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85 })
          .bytes();
      const stored = await fitted(IMAGE_LONGEST_SIDE);
      const thumbnail = await fitted(THUMBNAIL_SIDE);
      const size = await open(stored).metadata();
      return { bytes: stored, thumbnail, width: size.width, height: size.height };
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof SlotsFull) throw busy();
    if (codeOf(error) === 'ERR_IMAGE_TOO_MANY_PIXELS') throw tooLarge();
    if (codeOf(error) === 'ERR_IMAGE_DECODE_FAILED') {
      throw new AppError({
        code: 'IMAGE_UNREADABLE',
        message: 'That image could not be read.',
      });
    }
    throw error;
  }
};
