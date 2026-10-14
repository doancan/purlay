/**
 * One file of an export, for an owner to download (D-140): its directory as a POSIX `ustar` archive,
 * which every operating system opens without anything installed. Written here rather than added as a
 * dependency (CONTRIBUTING §1.12): the format is a 512-byte header before each file, the file padded
 * to 512, and two empty blocks at the end — and the export's names are short and plain by construction.
 *
 * Streamed: each file is read a chunk at a time into the archive, so its size is the disk's concern,
 * not memory's.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const BLOCK = 512;

/** A field of the header: text, NUL-padded to its width. */
const put = (header: Uint8Array, at: number, width: number, text: string): void => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > width) throw new Error(`a tar header field is too long: ${text}`);
  header.set(bytes, at);
};

/** A number of the header: octal, zero-padded, ending in NUL. */
const octal = (header: Uint8Array, at: number, width: number, value: number): void => {
  put(header, at, width, `${value.toString(8).padStart(width - 1, '0')}\0`);
};

/** The largest size the 11 octal digits of the field hold: 8 GiB less a byte. */
const OCTAL_SIZE_MAX = 8 ** 11 - 1;

/**
 * The size: octal while it fits, and past 8 GiB the base-256 form GNU tar and bsdtar read — a first
 * byte with its high bit set, then the number big-endian in the field's other eleven.
 */
const sizeField = (header: Uint8Array, size: number): void => {
  if (size <= OCTAL_SIZE_MAX) {
    octal(header, 124, 12, size);
    return;
  }
  header[124] = 0x80;
  let rest = BigInt(size);
  for (let at = 135; at > 124; at -= 1) {
    header[at] = Number(rest & 0xffn);
    rest >>= 8n;
  }
};

/** The 512 bytes before a file: its name, mode, size and time, and their checksum. */
export const tarHeader = (name: string, size: number, modifiedSeconds: number): Uint8Array => {
  const header = new Uint8Array(BLOCK);
  put(header, 0, 100, name);
  octal(header, 100, 8, 0o600);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  sizeField(header, size);
  octal(header, 136, 12, modifiedSeconds);
  // The checksum is summed with its own field as spaces.
  header.fill(0x20, 148, 156);
  put(header, 156, 1, '0');
  put(header, 257, 6, 'ustar\0');
  put(header, 263, 2, '00');
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(header, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return header;
};

/** The files under a directory, relative, in a stable order: the export's tables, then `blobs/`. */
const filesUnder = async (root: string, inside = ''): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of (await readdir(join(root, inside), { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const relative = inside === '' ? entry.name : `${inside}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await filesUnder(root, relative)));
    else if (entry.isFile()) found.push(relative);
    else throw new Error(`an export holds files only: ${relative}`);
  }
  return found;
};

/**
 * Writes the directory as one archive at `target` (owner-only), each file under `<prefix>/`. Answers
 * the archive's size.
 */
export const writeTar = async (
  directory: string,
  prefix: string,
  target: string,
  modifiedSeconds: number,
): Promise<number> => {
  const archive = await open(target, 'wx', 0o600);
  let written = 0;
  const write = async (bytes: Uint8Array): Promise<void> => {
    await archive.write(bytes);
    written += bytes.length;
  };
  try {
    for (const relative of await filesUnder(directory)) {
      const path = join(directory, relative);
      const { size } = await stat(path);
      await write(tarHeader(`${prefix}/${relative}`, size, modifiedSeconds));
      let copied = 0;
      for await (const chunk of Bun.file(path).stream()) {
        copied += chunk.byteLength;
        await write(chunk);
      }
      if (copied !== size) throw new Error(`${relative} changed while it was archived`);
      const pad = (BLOCK - (size % BLOCK)) % BLOCK;
      if (pad > 0) await write(new Uint8Array(pad));
    }
    await write(new Uint8Array(BLOCK * 2));
  } finally {
    await archive.close();
  }
  return written;
};
