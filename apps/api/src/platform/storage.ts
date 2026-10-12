/**
 * Where attachment bytes live (D-16, D-109): an S3-compatible bucket — Garage in the deployment
 * (`docs/spikes/object-storage.md`) — reached with Bun's own `S3Client`, nothing installed.
 *
 * A port, so the rules that use it are tested against a double and the adapter alone against a
 * real store (`storage.storage.test.ts`, `bun run test:storage`). Its one promise that matters for
 * safety: **absence is `null` and only absence is.** A store that refuses us — a wrong key, a
 * bucket that is gone, a network that is down — throws, so an outage is never told to a person as
 * "that file does not exist" (D-109's review, pre-mortem 7).
 */
import { S3Client } from 'bun';
import type { Config } from './config';
import { AppError } from './errors';

export interface ObjectStore {
  /** Writes the bytes under the key, replacing what was there. */
  readonly put: (key: string, bytes: Uint8Array, type: string) => Promise<void>;
  /** The object, or null when there is none. Any other failure throws. */
  readonly get: (key: string) => Promise<Blob | null>;
  /** Removes the object; removing one that is not there is not an error. */
  readonly delete: (key: string) => Promise<void>;
}

export interface S3Settings {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The store's answer for a key it does not hold — and nothing else. */
const isAbsent = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'NoSuchKey';

/** The part of Bun's `S3Client` the adapter uses: what a unit test stands in for. */
export interface S3Like {
  readonly write: (key: string, data: Uint8Array, options: { type: string }) => Promise<number>;
  readonly file: (key: string) => Blob & { readonly stat: () => Promise<unknown> };
  readonly delete: (key: string) => Promise<void>;
}

export const s3Store = (
  settings: S3Settings,
  client: S3Like = new S3Client(settings),
): ObjectStore => {
  return {
    put: async (key, bytes, type): Promise<void> => {
      await client.write(key, bytes, { type });
    },
    get: async (key): Promise<Blob | null> => {
      const file = client.file(key);
      try {
        await file.stat();
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
      return file;
    },
    delete: async (key): Promise<void> => {
      await client.delete(key);
    },
  };
};

/**
 * The store when none is configured: development or a test with no bucket. Using it is a loud
 * `503 STORAGE_UNAVAILABLE`, never a silent default — production refuses to start without one
 * (`config.ts`).
 */
const unconfiguredStore = (): ObjectStore => {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      new AppError({
        code: 'STORAGE_UNAVAILABLE',
        message: 'File storage is not configured on this server.',
      }),
    );
  return { put: unavailable, get: unavailable, delete: unavailable };
};

/** The store the configuration names, or the unconfigured one when it names none. */
export const storeFor = (config: Config): ObjectStore =>
  config.S3_ENDPOINT === undefined ||
  config.S3_BUCKET === undefined ||
  config.S3_ACCESS_KEY_ID === undefined ||
  config.S3_SECRET_ACCESS_KEY === undefined
    ? unconfiguredStore()
    : s3Store({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      });
