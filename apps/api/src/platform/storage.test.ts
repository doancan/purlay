/**
 * Which store a configuration gives, and that the one for no configuration refuses loudly (D-109):
 * a stable code a client can say, never a silent default and never "not found".
 */
import { describe, expect, test } from 'bun:test';
import { testConfig } from '../testing/doubles';
import { AppError } from './errors';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryStore, s3Store, storeFor, type S3Like } from './storage';

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof AppError) return error.body.code;
    throw error;
  }
  throw new Error('accepted where it had to be refused');
};

describe('the store a configuration gives', () => {
  test('none configured: every use is 503 STORAGE_UNAVAILABLE', async () => {
    const store = storeFor(testConfig());
    expect(await refusal(store.put('k', new Uint8Array([1]), 'application/octet-stream'))).toBe(
      'STORAGE_UNAVAILABLE',
    );
    expect(await refusal(store.get('k'))).toBe('STORAGE_UNAVAILABLE');
    expect(await refusal(store.delete('k'))).toBe('STORAGE_UNAVAILABLE');
  });

  test('a configured bucket is a real store, not the refusing one', () => {
    const store = storeFor(
      testConfig({
        S3_ENDPOINT: 'http://localhost:9000',
        S3_BUCKET: 'b',
        S3_ACCESS_KEY_ID: 'GK000000000000000000000001',
        S3_SECRET_ACCESS_KEY: 's'.repeat(64),
      }),
    );
    // Constructing it reaches nothing: the adapter is exercised against Garage by `test:storage`.
    expect(typeof store.put).toBe('function');
    expect(store).not.toEqual(storeFor(testConfig()));
  });
});

describe('the S3 adapter’s rules (a stand-in client; `test:storage` runs the real one)', () => {
  const settings = {
    endpoint: 'http://s3.test',
    region: 'us-east-1',
    bucket: 'b',
    accessKeyId: 'k',
    secretAccessKey: 's',
  };
  const client = (stat: () => Promise<unknown>, calls: string[]): S3Like => ({
    write: (key, data, options): Promise<number> => {
      const size = data instanceof Blob ? data.size : data.length;
      calls.push(`write ${key} ${String(size)} ${options.type}`);
      return Promise.resolve(size);
    },
    file: (key) =>
      Object.assign(new Blob(['x']), {
        stat: (): Promise<{ size: number }> => {
          calls.push(`stat ${key}`);
          return stat().then(() => ({ size: 1 }));
        },
      }),
    delete: (key): Promise<void> => {
      calls.push(`delete ${key}`);
      return Promise.resolve();
    },
  });

  test('put, get and delete reach the client with the key and the type', async () => {
    const calls: string[] = [];
    const store = s3Store(
      settings,
      client(() => Promise.resolve({}), calls),
    );
    await store.put('k', new Uint8Array([1, 2]), 'application/octet-stream');
    const got = await store.get('k');
    expect(got?.size).toBe(1);
    // Bytes of its own, not the client's handle: what a response is made of without a redirect.
    expect(new TextDecoder().decode(await new Response(got?.body).arrayBuffer())).toBe('x');
    await store.delete('k');
    expect(calls).toEqual(['write k 2 application/octet-stream', 'stat k', 'delete k']);
  });

  test('a file is handed to the client as the file, never read whole first', async () => {
    const calls: string[] = [];
    const store = s3Store(
      settings,
      client(() => Promise.resolve({}), calls),
    );
    const path = join(tmpdir(), `purlay-put-${crypto.randomUUID()}`);
    await Bun.write(path, new Uint8Array([1, 2, 3]));
    await store.putFile('k', path, 'application/x-tar');
    expect(calls).toEqual(['write k 3 application/x-tar']);
  });

  test('only the store’s own “no such key” is absence; any other failure is thrown', async () => {
    const absent = s3Store(
      settings,
      client(() => Promise.reject(Object.assign(new Error('gone'), { code: 'NoSuchKey' })), []),
    );
    expect(await absent.get('k')).toBeNull();
    const refused = s3Store(
      settings,
      client(
        () => Promise.reject(Object.assign(new Error('denied'), { code: 'AccessDenied' })),
        [],
      ),
    );
    let thrown = '';
    await refused.get('k').catch((error: unknown) => {
      thrown = error instanceof Error ? error.message : '';
    });
    expect(thrown).toBe('denied');
  });

  // A store that cannot be reached is an outage, said as one — not an INTERNAL that reads as a bug
  // (#708; Bun's code for a refused connection, measured: `ConnectionRefused`).
  test('a store that cannot be reached is 503 STORAGE_UNAVAILABLE, on every operation', async () => {
    const down = (): Promise<never> =>
      Promise.reject(
        Object.assign(new Error('an unexpected error has occurred'), { code: 'ConnectionRefused' }),
      );
    const unreachable: S3Like = {
      write: down,
      file: (key) => Object.assign(new Blob([key]), { stat: down }),
      delete: down,
    };
    const store = s3Store(settings, unreachable);
    expect(await refusal(store.put('k', new Uint8Array([1]), 'application/octet-stream'))).toBe(
      'STORAGE_UNAVAILABLE',
    );
    expect(await refusal(store.putFile('k', '/nonexistent', 'application/x-tar'))).toBe(
      'STORAGE_UNAVAILABLE',
    );
    expect(await refusal(store.get('k'))).toBe('STORAGE_UNAVAILABLE');
    expect(await refusal(store.delete('k'))).toBe('STORAGE_UNAVAILABLE');
  });
});

/**
 * The directory store (D-117, #387): a development store, so the demonstration and the browser suite
 * can upload without a bucket. Production refuses it (`config.test.ts`); here, that it is a store —
 * what is put is got, absence is null, removal is idempotent — and that a key cannot reach outside it.
 */
describe('the directory store', () => {
  const root = (): string => join(tmpdir(), `purlay-store-${crypto.randomUUID()}`);

  test('what is put is got back whole, with its size; what is not there is null; removing is idempotent', async () => {
    const store = directoryStore(root());
    const key = 'workspace-1/0199155c-6200-7b7f-8c11-000000000001/original';
    await store.put(key, new Uint8Array([1, 2, 3]), 'application/octet-stream');
    const got = await store.get(key);
    expect(got?.size).toBe(3);
    expect(new Uint8Array(await new Response(got?.body).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await store.delete(key);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    expect(await store.get('never/put')).toBeNull();
  });

  test('a file put by its path is got back whole', async () => {
    const store = directoryStore(root());
    const source = join(tmpdir(), `purlay-put-${crypto.randomUUID()}`);
    await Bun.write(source, new Uint8Array([4, 5, 6]));
    await store.putFile('workspace-1/exports/a.tar', source, 'application/x-tar');
    const got = await store.get('workspace-1/exports/a.tar');
    expect(new Uint8Array(await new Response(got?.body).arrayBuffer())).toEqual(
      new Uint8Array([4, 5, 6]),
    );
  });

  test('a key that would leave the directory is refused, never read or written', async () => {
    const store = directoryStore(root());
    const refused = async (work: Promise<unknown>): Promise<string> =>
      await work.then(
        () => 'done',
        (error: unknown) => (error instanceof Error ? error.message : 'other'),
      );
    for (const key of ['../escape', 'a/../../escape', '/etc/passwd', 'a//b', '', 'a\\b']) {
      expect(await refused(store.put(key, new Uint8Array([1]), 'x'))).toContain(
        'not a storage key',
      );
      expect(await refused(store.get(key))).toContain('not a storage key');
    }
  });

  test('the configuration names it when it names a directory and no bucket', () => {
    const store = storeFor(testConfig({ STORAGE_DIRECTORY: root() }));
    expect(store).not.toEqual(storeFor(testConfig()));
  });
});
