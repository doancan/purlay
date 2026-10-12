/**
 * What an image becomes (D-109 §1, §2): recognised by its bytes, refused before decoding when it
 * claims too many pixels, turned upright, never stretched, never enlarged, and stored as WebP with
 * its thumbnail — and anything that is not one of the four formats is not an image.
 */
import { describe, expect, test } from 'bun:test';
import { ATTACHMENT_PIXELS_MAX } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { claimingPng, twoColourPng } from '../../testing/png';
import {
  IMAGE_LONGEST_SIDE,
  SlotsFull,
  THUMBNAIL_SIDE,
  readImage,
  slots,
  type OpenImage,
} from './images';

/** A JPEG with an EXIF block carrying only an orientation, placed right after its start marker. */
const withOrientation = (jpeg: Uint8Array, orientation: number): Uint8Array => {
  // "Exif\0\0", then a little-endian TIFF header and one IFD entry: 0x0112, SHORT, 1, the value.
  const tiff = [0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0];
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, orientation, 0, 0, 0, 0, 0, 0, 0];
  const length = body.length + 2;
  const app1 = [0xff, 0xe1, length >> 8, length & 0xff, ...body];
  return new Uint8Array([...jpeg.subarray(0, 2), ...app1, ...jpeg.subarray(2)]);
};

/** One turn of the event loop: every settled promise has run its continuation. */
const aTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const meta = async (
  bytes: Uint8Array,
): Promise<{ width: number; height: number; format: string }> =>
  await new Bun.Image(bytes).metadata();

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

describe('an image', () => {
  test('is stored as WebP, its shape kept, with a thumbnail that fits the thumbnail box', async () => {
    const image = await readImage(twoColourPng(4000, 2000));
    if (image === null) throw new Error('not recognised');
    expect(image.width).toBe(IMAGE_LONGEST_SIDE);
    expect(image.height).toBe(IMAGE_LONGEST_SIDE / 2);
    expect(await meta(image.bytes)).toEqual({
      width: IMAGE_LONGEST_SIDE,
      height: IMAGE_LONGEST_SIDE / 2,
      format: 'webp',
    });
    expect(await meta(image.thumbnail)).toEqual({
      width: THUMBNAIL_SIDE,
      height: THUMBNAIL_SIDE / 2,
      format: 'webp',
    });
  });

  test('is never enlarged', async () => {
    const image = await readImage(twoColourPng(300, 100));
    expect([image?.width, image?.height]).toEqual([300, 100]);
    expect(await meta(image?.thumbnail ?? new Uint8Array())).toMatchObject({
      width: 300,
      height: 100,
    });
  });

  test('claiming more pixels than the bound is refused before it is decoded', async () => {
    const side = Math.ceil(Math.sqrt(ATTACHMENT_PIXELS_MAX)) + 1;
    expect(await refusal(readImage(claimingPng(side, side)))).toBe('IMAGE_TOO_LARGE');
    expect(await refusal(readImage(claimingPng(30_000, 10)))).toBe('IMAGE_TOO_LARGE');
  });

  test('that does not decode is refused as unreadable, not stored as something broken', async () => {
    const png = twoColourPng(200, 100);
    expect(await refusal(readImage(png.slice(0, 60)))).toBe('IMAGE_UNREADABLE');
  });

  test('is turned upright by its EXIF orientation, and the orientation is not kept', async () => {
    const jpeg = await new Bun.Image(twoColourPng(200, 100)).jpeg().bytes();
    const image = await readImage(withOrientation(jpeg, 6)); // 6: rotate 90° clockwise to view
    expect([image?.width, image?.height]).toEqual([100, 200]);
    // Read again, it is upright as stored: nothing is left to turn it a second time.
    const again = await readImage(image?.bytes ?? new Uint8Array());
    expect([again?.width, again?.height]).toEqual([100, 200]);
  });

  test('a failure that is not the decoder’s refusal is ours: thrown as it is, never “unreadable”', async () => {
    const broken: OpenImage = (bytes, options) =>
      Object.assign(new Bun.Image(bytes, options), {
        resize: (): never => {
          throw new TypeError('the encoder broke');
        },
      });
    let thrown: unknown = null;
    await readImage(twoColourPng(64, 64), broken).catch((error: unknown) => {
      thrown = error;
    });
    expect(thrown).toBeInstanceOf(TypeError);
  });
});

describe('not an image', () => {
  test('text, an empty file, or a format that is not one of the four is a file', async () => {
    expect(await readImage(new TextEncoder().encode('just words'))).toBeNull();
    expect(
      await readImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')),
    ).toBeNull();
    expect(await readImage(new Uint8Array([0x42, 0x4d, 0, 0]))).toBeNull(); // BMP: decodable, not ours
  });
});

describe('the decode slots', () => {
  test('never more at once than the limit — whenever a newcomer arrives as a slot is handed over', async () => {
    // A newcomer started at each depth of the microtask queue after a release: one of them lands
    // between the slot coming free and the waiter taking it.
    for (let depth = 0; depth < 16; depth += 1) {
      const run = slots(2);
      let running = 0;
      let most = 0;
      const releases: (() => void)[] = [];
      const job = (): Promise<void> =>
        run(async () => {
          running += 1;
          most = Math.max(most, running);
          await new Promise<void>((resolve) => releases.push(resolve));
          running -= 1;
        });
      const all = [job(), job(), job()];
      await aTurn();
      expect(releases).toHaveLength(2);
      releases.shift()?.();
      const later = (left: number): void => {
        if (left === 0) all.push(job());
        else
          queueMicrotask(() => {
            later(left - 1);
          });
      };
      later(depth);
      while (releases.length > 0) {
        await aTurn();
        releases.shift()?.();
        await aTurn();
      }
      await Promise.all(all);
      expect({ depth, most }).toEqual({ depth, most: 2 });
    }
  });

  test('with a bound on waiting, a job past it is refused at once and runs nothing; a freed place is taken again', async () => {
    const run = slots(1, 1);
    const releases: (() => void)[] = [];
    let ran = 0;
    const held = (): Promise<void> =>
      run(async () => {
        ran += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
      });
    const first = held();
    const second = held();
    await aTurn();
    let third: unknown = null;
    await run(() => Promise.resolve('never')).catch((error: unknown) => {
      third = error;
    });
    expect(third).toBeInstanceOf(SlotsFull);
    expect(ran).toBe(1);
    releases.shift()?.();
    await aTurn();
    releases.shift()?.();
    await Promise.all([first, second]);
    expect(ran).toBe(2);
    expect(await run(() => Promise.resolve('room again'))).toBe('room again');
  });

  test('a job that throws gives its slot back', async () => {
    const run = slots(1);
    await run(() => Promise.reject(new Error('broken'))).catch(() => undefined);
    expect(await run(() => Promise.resolve('next'))).toBe('next');
  });
});
