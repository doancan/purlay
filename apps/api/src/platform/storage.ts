/**
 * Where attachment bytes live (D-16, D-109): an S3-compatible bucket — Garage in the deployment
 * (`docs/spikes/object-storage.md`) — reached with Bun's own `S3Client`, nothing installed.
 *
 * A port, so the rules that use it are tested against a double and the adapter alone against a
 * real store (`storage.storage.test.ts`, `bun run test:storage`). Its one promise that matters for
 * safety: **absence is `null` and only absence is.** A store that refuses us — a wrong key, a
 * bucket that is gone, a network that is down — throws, so an outage is never told to a person as
 * "that file does not exist" (D-109's review, pre-mortem 7).
 *
 * **What is got is bytes, never the store's own handle.** Bun answers `new Response(s3File)` with a
 * redirect to a presigned URL — a public address for the bytes D-109 §6 brokers — and refuses one
 * that carries headers. So the adapter hands out a stream and its size, which serve as themselves.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { S3Client } from 'bun';
import type { Config } from './config';
import { AppError } from './errors';

/** An object's bytes, to be read once, and how many there are. */
export interface StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  readonly size: number;
}

export interface ObjectStore {
  /** Writes the bytes under the key, replacing what was there. */
  readonly put: (key: string, bytes: Uint8Array, type: string) => Promise<void>;
  /** Writes a file on this machine under the key, streamed: an export is larger than memory (D-140). */
  readonly putFile: (key: string, path: string, type: string) => Promise<void>;
  /** The object, or null when there is none. Any other failure throws. */
  readonly get: (key: string) => Promise<StoredObject | null>;
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
  readonly write: (
    key: string,
    data: Uint8Array | Blob,
    options: { type: string },
  ) => Promise<number>;
  readonly file: (
    key: string,
  ) => Blob & { readonly stat: () => Promise<{ readonly size: number }> };
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
    putFile: async (key, path, type): Promise<void> => {
      // Bun streams a file to S3 in parts, never whole in memory.
      await client.write(key, Bun.file(path), { type });
    },
    get: async (key): Promise<StoredObject | null> => {
      const file = client.file(key);
      let size: number;
      try {
        ({ size } = await file.stat());
      } catch (error) {
        if (isAbsent(error)) return null;
        throw error;
      }
      return { body: file.stream(), size };
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
  return { put: unavailable, putFile: unavailable, get: unavailable, delete: unavailable };
};

/** What a storage key is: the store's own names (`workspace/upload-id/variant`), nothing a path could escape by. */
const KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)*$/;

/**
 * Attachments in a directory instead of a bucket (D-117): what the demonstration and the browser suite
 * run on, so an upload works there without Garage. The configuration refuses it in production.
 * A key is checked before it becomes a path: segments of letters, digits, `_`, `-` and inner dots —
 * no `..`, no absolute path, no empty segment — so nothing outside the directory is read or written.
 */
export const directoryStore = (root: string): ObjectStore => {
  const pathOf = (key: string): string => {
    if (!KEY.test(key)) throw new Error(`not a storage key: ${JSON.stringify(key)}`);
    return join(root, key);
  };
  return {
    put: async (key, bytes): Promise<void> => {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, bytes);
    },
    putFile: async (key, source): Promise<void> => {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await Bun.write(path, Bun.file(source));
    },
    get: async (key): Promise<StoredObject | null> => {
      const file = Bun.file(pathOf(key));
      if (!(await file.exists())) return null;
      return { body: file.stream(), size: file.size };
    },
    delete: async (key): Promise<void> => {
      await rm(pathOf(key), { force: true });
    },
  };
};

/** The store the configuration names — the bucket, a development directory — or the unconfigured one. */
export const storeFor = (config: Config): ObjectStore =>
  config.S3_ENDPOINT === undefined ||
  config.S3_BUCKET === undefined ||
  config.S3_ACCESS_KEY_ID === undefined ||
  config.S3_SECRET_ACCESS_KEY === undefined
    ? config.STORAGE_DIRECTORY === undefined
      ? unconfiguredStore()
      : directoryStore(config.STORAGE_DIRECTORY)
    : s3Store({
        endpoint: config.S3_ENDPOINT,
        region: config.S3_REGION,
        bucket: config.S3_BUCKET,
        accessKeyId: config.S3_ACCESS_KEY_ID,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      });
