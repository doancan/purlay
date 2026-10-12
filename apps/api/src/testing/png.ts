/**
 * PNG images made in code, for the tests of the image pipeline (D-109 §1, §2): a picture whose two
 * halves differ, so a stretch is visible; a header that claims more pixels than it carries; any
 * size. Made here rather than kept as files, so a fixture says what it is.
 */
import { deflateSync } from 'node:zlib';

const crc = (bytes: Uint8Array): number => Bun.hash.crc32(bytes);

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
  return out;
};

const header = (width: number, height: number): Uint8Array => {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data.set([8, 2, 0, 0, 0], 8); // 8 bits, RGB, deflate, no filter, no interlace
  return chunk('IHDR', data);
};

const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const join = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** A `width`×`height` picture: the left half `left`, the right half `right` (RGB). */
export const twoColourPng = (
  width: number,
  height: number,
  left: readonly [number, number, number] = [255, 0, 0],
  right: readonly [number, number, number] = [0, 0, 255],
): Uint8Array => {
  const row = new Uint8Array(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(x < width / 2 ? left : right, 1 + x * 3);
  const raw = new Uint8Array(row.length * height);
  for (let y = 0; y < height; y += 1) raw.set(row, y * row.length);
  return join([
    SIGNATURE,
    header(width, height),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ]);
};

/** A header that claims `width`×`height` and no pixels at all: what a decompression bomb starts as. */
export const claimingPng = (width: number, height: number): Uint8Array =>
  join([SIGNATURE, header(width, height), chunk('IEND', new Uint8Array())]);
