/**
 * Preparing the store on `up` (#76, D-144), against a stand-in for Garage's admin API that keeps the
 * state the real one does (`docs/spikes/garage-admin.md` ran the same steps against Garage itself):
 * each step only when missing, nothing done the second time, and every way it can be wrong said and
 * exited on — never a store half-made that the API starts against.
 */
import { describe, expect, test } from 'bun:test';
import { initStorage, settingsFrom, type FetchPort, type StorageSettings } from './storage-setup';

const SETTINGS: StorageSettings = {
  adminUrl: 'http://garage:3903',
  adminToken: 'token',
  s3Endpoint: 'http://garage:3900',
  bucket: 'purlay-attachments',
  accessKeyId: 'GK' + 'd'.repeat(24),
  secretAccessKey: 'e'.repeat(64),
};

interface Garage {
  role: object | null;
  layoutVersion: number;
  bucket: {
    id: string;
    keys: { accessKeyId: string; permissions: Record<string, boolean> }[];
  } | null;
  key: boolean;
  anonymous: number | 'unreachable';
  nodes: number;
  calls: string[];
}

const aGarage = (over: Partial<Garage> = {}): Garage => ({
  role: null,
  layoutVersion: 0,
  bucket: null,
  key: false,
  anonymous: 403,
  nodes: 1,
  calls: [],
  ...over,
});

/** Garage's admin API as far as the steps use it, keeping what each call changes. */
const served = (garage: Garage): FetchPort => {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });
  return (url, init) => {
    const { pathname, search } = new URL(url);
    if (url.startsWith(SETTINGS.s3Endpoint)) {
      return garage.anonymous === 'unreachable'
        ? Promise.reject(new TypeError('connection refused'))
        : Promise.resolve(new Response('', { status: garage.anonymous }));
    }
    const headers = new Headers(init?.headers);
    if (headers.get('authorization') !== `Bearer ${SETTINGS.adminToken}`) {
      return Promise.resolve(json(403, { code: 'Forbidden' }));
    }
    const step = pathname.replace('/v2/', '');
    garage.calls.push(step);
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    switch (step) {
      case 'GetClusterStatus':
        return Promise.resolve(
          json(200, {
            layoutVersion: garage.layoutVersion,
            nodes: Array.from({ length: garage.nodes }, (_, at) => ({
              id: `node-${String(at)}`,
              role: garage.role,
            })),
          }),
        );
      case 'UpdateClusterLayout':
        return Promise.resolve(json(200, { stagedRoleChanges: body['roles'] }));
      case 'ApplyClusterLayout':
        expect(body['version']).toBe(garage.layoutVersion + 1);
        garage.layoutVersion += 1;
        garage.role = { zone: 'local' };
        return Promise.resolve(json(200, { message: [] }));
      case 'GetBucketInfo':
        expect(search).toBe(`?globalAlias=${SETTINGS.bucket}`);
        return Promise.resolve(
          garage.bucket === null ? json(404, { code: 'NoSuchBucket' }) : json(200, garage.bucket),
        );
      case 'CreateBucket':
        garage.bucket = { id: 'bucket-1', keys: [] };
        return Promise.resolve(json(200, garage.bucket));
      case 'GetKeyInfo':
        return Promise.resolve(garage.key ? json(200, {}) : json(404, { code: 'NoSuchKey' }));
      case 'ImportKey':
        expect(body).toEqual({
          accessKeyId: SETTINGS.accessKeyId,
          secretAccessKey: SETTINGS.secretAccessKey,
          name: 'purlay',
        });
        garage.key = true;
        return Promise.resolve(json(200, {}));
      case 'AllowBucketKey':
        expect(body['permissions']).toEqual({ read: true, write: true, owner: true });
        garage.bucket?.keys.push({
          accessKeyId: SETTINGS.accessKeyId,
          permissions: { read: true, write: true, owner: true },
        });
        return Promise.resolve(json(200, garage.bucket));
      default:
        return Promise.resolve(json(404, {}));
    }
  };
};

const outcome = async (garage: Garage, settings = SETTINGS): Promise<string> =>
  await initStorage(settings, served(garage)).then(
    (done) => done.join(','),
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('preparing the store', () => {
  test('a new store: the layout, the bucket, the key and its rights, in that order', async () => {
    const garage = aGarage();
    expect(await outcome(garage)).toBe('layout,bucket,key,rights');
    expect(garage.calls).toEqual([
      'GetClusterStatus',
      'UpdateClusterLayout',
      'ApplyClusterLayout',
      'GetBucketInfo',
      'CreateBucket',
      'GetKeyInfo',
      'ImportKey',
      'AllowBucketKey',
    ]);
  });

  test('a prepared store: read, and nothing done — every `up` runs it', async () => {
    const garage = aGarage();
    await outcome(garage);
    garage.calls.length = 0;
    expect(await outcome(garage)).toBe('');
    expect(garage.calls).toEqual(['GetClusterStatus', 'GetBucketInfo', 'GetKeyInfo']);
  });

  test('a key there without its rights is given them; one already holding them is not asked again', async () => {
    const garage = aGarage({ role: {}, bucket: { id: 'b', keys: [] }, key: true });
    expect(await outcome(garage)).toBe('rights');
  });

  test('an anonymous read that is answered, or unreachable, fails the run', async () => {
    expect(await outcome(aGarage({ anonymous: 200 }))).toContain(
      'answered 200, where it must be refused with 403',
    );
    expect(await outcome(aGarage({ anonymous: 'unreachable' }))).toContain('answered unreachable');
  });

  test('a wrong token, or more than one node, is said and stops it before anything is changed', async () => {
    const garage = aGarage();
    expect(await outcome(garage, { ...SETTINGS, adminToken: 'wrong' })).toBe(
      'reading the cluster: the admin API answered 403',
    );
    expect(garage.calls).toEqual([]);
    const two = aGarage({ nodes: 2 });
    expect(await outcome(two)).toBe('expected one Garage node, found 2');
    expect(two.calls).toEqual(['GetClusterStatus']);
  });

  test('the settings are the environment the compose file gives it; a missing one is named', () => {
    const env = {
      GARAGE_ADMIN_URL: SETTINGS.adminUrl,
      GARAGE_ADMIN_TOKEN: SETTINGS.adminToken,
      S3_ENDPOINT: SETTINGS.s3Endpoint,
      S3_ACCESS_KEY_ID: SETTINGS.accessKeyId,
      S3_SECRET_ACCESS_KEY: SETTINGS.secretAccessKey,
    };
    expect(settingsFrom(env)).toEqual(SETTINGS);
    expect(() => settingsFrom({ ...env, GARAGE_ADMIN_TOKEN: '' })).toThrow(
      'GARAGE_ADMIN_TOKEN is not set',
    );
  });
});
