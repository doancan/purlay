/**
 * Which store a configuration gives, and that the one for no configuration refuses loudly (D-109):
 * a stable code a client can say, never a silent default and never "not found".
 */
import { describe, expect, test } from 'bun:test';
import { testConfig } from '../testing/doubles';
import { AppError } from './errors';
import { s3Store, storeFor, type S3Like } from './storage';

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
      calls.push(`write ${key} ${String(data.length)} ${options.type}`);
      return Promise.resolve(data.length);
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
});
