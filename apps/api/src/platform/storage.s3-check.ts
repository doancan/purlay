/**
 * The S3 adapter against a real S3-compatible store — Garage, as the deployment runs (D-109).
 *
 * Not found by `bun test`'s own discovery, so not part of `test:all`: CI runs PostgreSQL alone (`CONTRIBUTING.md` §2), and a test that cannot
 * reach its store must refuse rather than pass. Run it with `bun run test:storage` against
 * `bun run db:up`. The rules that use the store are tested against the in-memory double; this file
 * is what makes that double an honest stand-in.
 */
import { describe, expect, test } from 'bun:test';
import { s3Store } from './storage';

const endpoint = process.env['S3_ENDPOINT'];
if (endpoint === undefined || endpoint === '') {
  throw new Error('S3_ENDPOINT is not set: run `bun run db:up`, then `bun run test:storage`.');
}

const settings = {
  endpoint,
  region: process.env['S3_REGION'] ?? 'us-east-1',
  bucket: process.env['S3_BUCKET'] ?? 'purlay-attachments',
  accessKeyId: process.env['S3_ACCESS_KEY_ID'] ?? '',
  secretAccessKey: process.env['S3_SECRET_ACCESS_KEY'] ?? '',
};

const key = (): string => `test/${crypto.randomUUID()}`;

describe('the S3 store, against Garage', () => {
  test('what is put is what is got, with its type, and deleting it leaves nothing', async () => {
    const store = s3Store(settings);
    const at = key();
    const bytes = new TextEncoder().encode('the bytes, exactly');
    await store.put(at, bytes, 'application/octet-stream');
    const got = await store.get(at);
    if (got === null) throw new Error('what was put was not there');
    expect(got.size).toBe(bytes.length);
    expect(new Uint8Array(await new Response(got.body).arrayBuffer())).toEqual(bytes);
    await store.delete(at);
    expect(await store.get(at)).toBeNull();
  });

  test('what is got can be served as a response of its own, with headers: bytes, never a redirect', async () => {
    // Bun answers \`new Response(s3File)\` with a redirect to a presigned URL, and refuses one with
    // headers: an S3 file handed out of the adapter is either a public URL or a 500 (D-109 §6).
    const store = s3Store(settings);
    const at = key();
    const bytes = new TextEncoder().encode('served, not redirected');
    await store.put(at, bytes, 'application/octet-stream');
    const got = await store.get(at);
    if (got === null) throw new Error('what was put was not there');
    const response = new Response(got.body, {
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    await store.delete(at);
  });

  test('a key that was never written is null; deleting it is not an error', async () => {
    const store = s3Store(settings);
    const at = key();
    expect(await store.get(at)).toBeNull();
    await store.delete(at);
  });

  test('a store that refuses us is an error, never an empty answer that looks like absence', async () => {
    const store = s3Store({ ...settings, secretAccessKey: 'f'.repeat(64) });
    let refused = false;
    await store.get(key()).catch(() => {
      refused = true;
    });
    expect(refused).toBe(true);
  });
});
