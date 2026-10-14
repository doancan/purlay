/**
 * Prepares the production stack's object store on `up`, so a self-hoster's first command is the only
 * one (#76, D-144): what `cli/storage-init.ts` runs, from the one-shot service of that name in
 * `docker-compose.production.yml`, before the API starts.
 *
 * Through Garage's admin API (the image carries no shell for compose to run its CLI with,
 * `docs/spikes/garage-admin.md`), and safe to run on every `up`: each step reads first and does only
 * what is missing — the node's place in the layout, the bucket, the application's key, and the key's
 * rights on the bucket. Then it looks at the store as a stranger would: an anonymous read must be
 * refused with 403, not answered and not unreachable (CONTRIBUTING §6.4). Anything else exits non-zero
 * with what it found, and the API does not start.
 *
 * Nothing secret is printed: the key's id is, its secret never is.
 */

/** The capacity given to the one node: a placeholder Garage requires, not a quota (one node holds all). */
const NODE_CAPACITY_BYTES = 1_000_000_000;

export interface StorageSettings {
  /** Garage's admin API, inside the stack: `http://garage:3903`. */
  readonly adminUrl: string;
  readonly adminToken: string;
  /** Garage's S3 API, inside the stack: what the API uses, and what the anonymous read probes. */
  readonly s3Endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type FetchPort = (url: string, init?: RequestInit) => Promise<Response>;

/** What was done, in order: an `up` on a prepared store answers with nothing done. */
export type Step = 'layout' | 'bucket' | 'key' | 'rights';

export const initStorage = async (
  settings: StorageSettings,
  fetchFn: FetchPort,
): Promise<readonly Step[]> => {
  const done: Step[] = [];
  const admin = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly json: unknown }> => {
    const response = await fetchFn(`${settings.adminUrl}/v2/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${settings.adminToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json };
  };
  const expect = (
    answer: { readonly status: number; readonly json: unknown },
    what: string,
  ): Record<string, unknown> => {
    if (answer.status !== 200 || typeof answer.json !== 'object' || answer.json === null) {
      throw new Error(`${what}: the admin API answered ${String(answer.status)}`);
    }
    return answer.json as Record<string, unknown>;
  };

  // 1. The node has a place in the layout, or it can store nothing.
  const status = expect(await admin('GET', 'GetClusterStatus'), 'reading the cluster');
  const nodes = Array.isArray(status['nodes'])
    ? (status['nodes'] as Record<string, unknown>[])
    : [];
  const [node] = nodes;
  if (node === undefined || nodes.length !== 1 || typeof node['id'] !== 'string') {
    throw new Error(`expected one Garage node, found ${String(nodes.length)}`);
  }
  if (node['role'] === null || node['role'] === undefined) {
    expect(
      await admin('POST', 'UpdateClusterLayout', {
        roles: [{ id: node['id'], zone: 'local', capacity: NODE_CAPACITY_BYTES, tags: [] }],
      }),
      'staging the layout',
    );
    const version = typeof status['layoutVersion'] === 'number' ? status['layoutVersion'] : 0;
    expect(
      await admin('POST', 'ApplyClusterLayout', { version: version + 1 }),
      'applying the layout',
    );
    done.push('layout');
  }

  // 2. The bucket.
  const alias = encodeURIComponent(settings.bucket);
  let bucket = await admin('GET', `GetBucketInfo?globalAlias=${alias}`);
  if (bucket.status === 404) {
    bucket = await admin('POST', 'CreateBucket', { globalAlias: settings.bucket });
    done.push('bucket');
  }
  const bucketInfo = expect(bucket, 'the bucket');
  if (typeof bucketInfo['id'] !== 'string') throw new Error('the bucket has no id');

  // 3. The application's key, imported from the deployment's variables.
  const id = encodeURIComponent(settings.accessKeyId);
  const key = await admin('GET', `GetKeyInfo?id=${id}`);
  if (key.status === 404) {
    expect(
      await admin('POST', 'ImportKey', {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
        name: 'purlay',
      }),
      'importing the key',
    );
    done.push('key');
  } else {
    expect(key, 'the key');
  }

  // 4. Its rights on the bucket: read, write, owner — what the API needs, granted again harmlessly.
  const keys = Array.isArray(bucketInfo['keys'])
    ? (bucketInfo['keys'] as Record<string, unknown>[])
    : [];
  const granted = keys.find((entry) => entry['accessKeyId'] === settings.accessKeyId);
  const rights = granted?.['permissions'] as Record<string, unknown> | undefined;
  if (rights?.['read'] !== true || rights['write'] !== true || rights['owner'] !== true) {
    expect(
      await admin('POST', 'AllowBucketKey', {
        bucketId: bucketInfo['id'],
        accessKeyId: settings.accessKeyId,
        permissions: { read: true, write: true, owner: true },
      }),
      'granting the key its rights',
    );
    done.push('rights');
  }

  // 5. As a stranger sees it: refused.
  const probe = await fetchFn(`${settings.s3Endpoint}/${alias}/probe`).then(
    (response) => response.status,
    () => 'unreachable',
  );
  if (probe !== 403) {
    throw new Error(
      `an anonymous read of the bucket answered ${String(probe)}, where it must be refused with 403`,
    );
  }
  return done;
};

/** The settings from the environment the compose file gives the service; a missing one is named. */
export const settingsFrom = (
  env: Readonly<Record<string, string | undefined>>,
): StorageSettings => {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') throw new Error(`${name} is not set`);
    return value;
  };
  return {
    adminUrl: read('GARAGE_ADMIN_URL'),
    adminToken: read('GARAGE_ADMIN_TOKEN'),
    s3Endpoint: read('S3_ENDPOINT'),
    bucket: env['S3_BUCKET'] ?? 'purlay-attachments',
    accessKeyId: read('S3_ACCESS_KEY_ID'),
    secretAccessKey: read('S3_SECRET_ACCESS_KEY'),
  };
};
