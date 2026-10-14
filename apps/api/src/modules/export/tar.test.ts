/**
 * The export's archive (D-140) opens with the operating system's own `tar`: names, bytes and sizes
 * come back as they went in, a file of exactly a block and one of none included, and the header's
 * checksum is the one `tar` computes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarHeader, writeTar } from './tar';

describe('the export’s archive', () => {
  test('opens with tar, every file as it went in', async () => {
    const root = await mkdtemp(join(tmpdir(), 'purlay-tar-'));
    const source = join(root, 'export');
    await mkdir(join(source, 'blobs'), { recursive: true });
    const files: Record<string, Uint8Array> = {
      'manifest.json': new TextEncoder().encode('{"format":1}\n'),
      'messages.ndjson': new Uint8Array(512).fill(65),
      'empty.ndjson': new Uint8Array(0),
      'blobs/0199155c-6200-7b7f-8c11-2a4d3f9e1b70': new Uint8Array(1300).map((_, n) => n % 256),
    };
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(source, name), bytes);
    const archive = join(root, 'export.tar');
    const size = await writeTar(source, 'acme-export', archive, 1_760_000_000);
    expect(size % 512).toBe(0);

    const listed = Bun.spawnSync(['tar', '-tf', archive]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout.toString().trim().split('\n').sort()).toEqual(
      Object.keys(files)
        .map((name) => `acme-export/${name}`)
        .sort(),
    );
    const out = join(root, 'out');
    await mkdir(out);
    expect(Bun.spawnSync(['tar', '-xf', archive, '-C', out]).exitCode).toBe(0);
    for (const [name, bytes] of Object.entries(files)) {
      expect([...(await readFile(join(out, 'acme-export', name)))]).toEqual([...bytes]);
    }
  });

  test('refuses a name its header cannot hold, rather than cut it', () => {
    expect(() => tarHeader('x'.repeat(101), 0, 0)).toThrow('too long');
  });

  test('a size past 8 GiB is written base-256, as tar reads it', () => {
    const size = 9 * 1024 ** 3;
    const header = tarHeader('big.ndjson', size, 0);
    expect(header[124]).toBe(0x80);
    let read = 0n;
    for (let at = 125; at < 136; at += 1) read = (read << 8n) | BigInt(header[at] ?? 0);
    expect(read).toBe(BigInt(size));
    // Below the line, octal as before.
    expect(new TextDecoder().decode(tarHeader('small', 8, 0).slice(124, 135))).toBe('00000000010');
  });
});
