/**
 * Decodes a test holds: `Bun.Image` as it is, except that an encode waits until the test lets it go —
 * so a decode keeps its slot for exactly as long as the test needs, with no clock involved.
 */
import type { OpenImage } from '../modules/attachments/images';

/** One turn of the event loop: every settled promise has run its continuation. */
const aTurn = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * An `open` whose encodes wait until `release` is called: a decode holds its slot for as long as a test
 * needs, and `headers` counts the decodes that have read their header and gone for a slot.
 */
export const heldDecodes = (): {
  readonly open: OpenImage;
  readonly release: () => void;
  readonly headers: () => number;
  readonly encoding: () => number;
} => {
  const gate = Promise.withResolvers<undefined>();
  let headers = 0;
  let encoding = 0;
  const open: OpenImage = (bytes, options) => {
    const image = new Bun.Image(bytes, options);
    return Object.assign(image, {
      metadata: async (): Promise<Awaited<ReturnType<Bun.Image['metadata']>>> => {
        const read = await Bun.Image.prototype.metadata.call(image);
        headers += 1;
        return read;
      },
      bytes: async (): Promise<Uint8Array> => {
        encoding += 1;
        await gate.promise;
        return await Bun.Image.prototype.bytes.call(image);
      },
    });
  };
  return {
    open,
    release: (): void => {
      gate.resolve(undefined);
    },
    headers: (): number => headers,
    encoding: (): number => encoding,
  };
};

/** Until `done` holds, a turn at a time — a positive condition, never a fixed sleep. */
export const until = async (done: () => boolean): Promise<void> => {
  for (let turn = 0; !done(); turn += 1) {
    if (turn > 10_000) throw new Error('waited ten thousand turns for a condition that never held');
    await aTurn();
  }
  await aTurn();
};
