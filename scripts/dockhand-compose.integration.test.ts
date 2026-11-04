import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Dockhand compose file is the production stack in one file, behind Nginx Proxy Manager (D-258).
 *
 * Like `production-compose.integration.test.ts`, it asks `docker compose config` and Caddy itself rather
 * than reading the YAML. Its main job is to hold the two files equal everywhere they are meant to be
 * equal, so a change to the production stack that is not made here fails here, and to pin the few ways
 * they differ: no published port, Nginx Proxy Manager's network, the client address, no WAL archiving.
 */
const repo = join(import.meta.dir, '..');
const DOCKHAND = join(repo, 'docker-compose.dockhand.yml');
const PRODUCTION = join(repo, 'docker-compose.production.yml');
const config = readFileSync(join(repo, 'docs/CONFIG.md'), 'utf8');

const ENVIRONMENT: Record<string, string> = {
  PURLAY_IMAGE: 'ghcr.io/example/purlay-api@sha256:' + 'a'.repeat(64),
  APP_URL: 'https://chat.example.test',
  POSTGRES_PASSWORD: 'f'.repeat(32),
  GARAGE_RPC_SECRET: 'c'.repeat(64),
  GARAGE_ADMIN_TOKEN: 'b'.repeat(64),
  S3_ACCESS_KEY_ID: 'GK' + 'd'.repeat(24),
  S3_SECRET_ACCESS_KEY: 'e'.repeat(64),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  PROXY_NETWORK: 'npm_default',
};

type Service = Record<string, unknown> & {
  image?: string;
  ports?: unknown[];
  volumes?: { type: string; source?: string; target?: string }[];
  configs?: { source: string; target: string }[];
  networks?: Record<string, { aliases?: string[] } | null>;
  environment?: Record<string, string>;
  entrypoint?: string[];
};
interface Resolved {
  services: Record<string, Service>;
  networks?: Record<string, { name?: string; external?: boolean }>;
  configs?: Record<string, { content?: string }>;
}

/** The caller's environment minus the stack's variables: an exported one would hide a missing one. */
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !(key in ENVIRONMENT)),
);

const resolve = (
  file: string,
  environment: Record<string, string>,
): { code: number; stdout: string; stderr: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'compose-'));
  try {
    const envFile = join(directory, 'stack.env');
    writeFileSync(
      envFile,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    // A project name of its own, so both files resolve under one and their names compare.
    const run = Bun.spawnSync(
      [
        'docker',
        'compose',
        '-p',
        'purlay',
        '-f',
        file,
        '--env-file',
        envFile,
        'config',
        '--format',
        'json',
      ],
      { stdout: 'pipe', stderr: 'pipe', env: inherited },
    );
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const model = (file: string): Resolved => {
  const resolved = resolve(file, ENVIRONMENT);
  if (resolved.code !== 0) throw new Error(`docker compose config failed: ${resolved.stderr}`);
  return JSON.parse(resolved.stdout) as Resolved;
};

/** A service without the keys named, for comparing what is meant to be equal. */
const without = (service: Service | undefined, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(service ?? {}).filter(([key]) => !keys.includes(key)));

/** Every object in a JSON tree, so a test finds a handler wherever Caddy nested it. */
const objectsIn = (value: unknown): Record<string, unknown>[] => {
  if (Array.isArray(value)) return value.flatMap(objectsIn);
  if (typeof value !== 'object' || value === null) return [];
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap(objectsIn)];
};

describe('integration: the Dockhand compose file', () => {
  const probe = Bun.spawnSync(['docker', 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' });
  if (probe.exitCode !== 0) {
    throw new Error(
      'the Docker CLI with the compose plugin is required; without it this would prove nothing',
    );
  }

  const dockhand = model(DOCKHAND);
  const production = model(PRODUCTION);
  const caddyfile = dockhand.configs?.['caddyfile']?.content ?? '';
  const proxyImage = dockhand.services['proxy']?.image ?? '';

  /** The Caddyfile as Caddy itself reads it: what is asserted is what it will do. */
  const adapted = ((): unknown => {
    const directory = mkdtempSync(join(tmpdir(), 'caddy-'));
    try {
      writeFileSync(join(directory, 'Caddyfile'), caddyfile);
      const caddy = Bun.spawnSync(
        [
          'docker',
          'run',
          '--rm',
          '-v',
          `${join(directory, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`,
          proxyImage,
          'caddy',
          'adapt',
          '--config',
          '/etc/caddy/Caddyfile',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if (caddy.exitCode !== 0) throw new Error(`caddy adapt failed: ${caddy.stderr.toString()}`);
      return JSON.parse(caddy.stdout.toString());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();

  test('has the services of the production stack, no more and no fewer', () => {
    expect(Object.keys(dockhand.services).sort()).toEqual(Object.keys(production.services).sort());
  });

  test('the API, the scheduler and the store’s preparation are the production ones exactly', () => {
    for (const name of ['api', 'scheduler', 'storage-init']) {
      expect({ name, service: without(dockhand.services[name], 'networks') }).toEqual({
        name,
        service: without(production.services[name], 'networks'),
      });
    }
  });

  test('PostgreSQL is production’s, without the WAL archiving that needs a mounted script', () => {
    const postgres = dockhand.services['postgres'];
    expect(
      without(postgres, 'networks', 'entrypoint', 'command', 'volumes', 'environment'),
    ).toEqual(
      without(
        production.services['postgres'],
        'networks',
        'entrypoint',
        'command',
        'volumes',
        'environment',
      ),
    );
    const settings = Object.fromEntries(
      Object.entries(production.services['postgres']?.environment ?? {}).filter(
        ([name]) => !name.startsWith('WAL_ARCHIVE'),
      ),
    );
    expect(postgres?.environment).toEqual(settings);
    // The image's own entrypoint and command (production's wrapper runs `postgres` too), and only the
    // data volume.
    expect(postgres?.entrypoint ?? null).toBeNull();
    expect(postgres?.['command'] ?? null).toBeNull();
    expect(postgres?.volumes?.map((volume) => [volume.type, volume.target])).toEqual([
      ['volume', '/var/lib/postgresql'],
    ]);
  });

  test('Garage is production’s, its configuration the production file word for word', () => {
    expect(without(dockhand.services['garage'], 'networks', 'volumes', 'configs')).toEqual(
      without(production.services['garage'], 'networks', 'volumes', 'configs'),
    );
    expect(dockhand.services['garage']?.configs).toEqual([
      expect.objectContaining({ source: 'garage', target: '/etc/garage.toml' }),
    ]);
    expect(dockhand.configs?.['garage']?.content).toBe(
      readFileSync(join(repo, 'docker/garage.production.toml'), 'utf8'),
    );
  });

  test('nothing is read from the host: no bind mount, so the file stands alone', () => {
    for (const [name, service] of Object.entries(dockhand.services)) {
      const binds = (service.volumes ?? []).filter((volume) => volume.type !== 'volume');
      expect({ name, binds }).toEqual({ name, binds: [] });
    }
  });

  test('no port is published: Nginx Proxy Manager reaches Caddy on its own network as `purlay`', () => {
    for (const [name, service] of Object.entries(dockhand.services)) {
      expect({ name, ports: service.ports ?? [] }).toEqual({ name, ports: [] });
    }
    expect(dockhand.networks?.['edge']).toMatchObject({ name: 'npm_default', external: true });
    expect(dockhand.services['proxy']?.networks?.['edge']?.aliases).toEqual(['purlay']);
    // Only the proxy is on that network: the API, the database and the store are not.
    const onEdge = Object.entries(dockhand.services)
      .filter(([, service]) => service.networks !== undefined && 'edge' in service.networks)
      .map(([name]) => name);
    expect(onEdge).toEqual(['proxy']);
  });

  test('without PROXY_NETWORK it stops and names it', () => {
    const rest = Object.fromEntries(
      Object.entries(ENVIRONMENT).filter(([name]) => name !== 'PROXY_NETWORK'),
    );
    const missing = resolve(DOCKHAND, rest);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('PROXY_NETWORK');
  });

  test('the proxy is production’s Caddy, with the same bounds', () => {
    expect(
      without(dockhand.services['proxy'], 'networks', 'volumes', 'configs', 'ports', 'environment'),
    ).toEqual(
      without(
        production.services['proxy'],
        'networks',
        'volumes',
        'configs',
        'ports',
        'environment',
      ),
    );
  });

  test('Caddy serves plain HTTP on 80, and takes the client from Nginx Proxy Manager’s X-Real-IP alone', () => {
    const servers = objectsIn(adapted).find((object) => 'srv0' in object)?.['srv0'] as
      Record<string, unknown> | undefined;
    expect(servers?.['listen']).toEqual([':80']);
    // X-Forwarded-For is not believed: Nginx Proxy Manager appends to the client's own, so its first
    // entry is whatever the client wrote. X-Real-IP it sets to the peer it saw.
    expect(servers?.['client_ip_headers']).toEqual(['X-Real-IP']);
    expect(
      objectsIn(servers?.['trusted_proxies']).some((source) => source['source'] === 'static'),
    ).toBe(true);
    // The API trusts one proxy and reads the last X-Forwarded-For entry (D-81): it is given one.
    const proxy = objectsIn(adapted).find((handler) => handler['handler'] === 'reverse_proxy');
    expect(
      objectsIn(proxy?.['headers']).some((headers) => {
        const set = headers['set'] as Record<string, string[]> | undefined;
        return set?.['X-Forwarded-For']?.[0] === '{http.vars.client_ip}';
      }),
    ).toBe(true);
  });

  test('Caddy keeps production’s duties: /metrics refused, a restart waited for, no query in the log', () => {
    const routes = objectsIn(adapted).filter((route) => Array.isArray(route['match']));
    const refusing = routes.find((route) =>
      objectsIn(route['match']).some(
        (match) =>
          Array.isArray(match['path']) &&
          (match['path'] as unknown[]).includes('/metrics') &&
          (match['path'] as unknown[]).includes('/metrics/*'),
      ),
    );
    expect(objectsIn(refusing?.['handle'])[0]?.['status_code']).toBe(404);

    const proxies = objectsIn(adapted).filter((handler) => handler['handler'] === 'reverse_proxy');
    expect(proxies).toHaveLength(1);
    const balancing = proxies[0]?.['load_balancing'] as Record<string, unknown> | undefined;
    expect(balancing?.['try_duration']).toBe(30_000_000_000);
    expect(balancing?.['retry_match']).toEqual([{ expression: 'false' }]);

    const filtering = objectsIn(adapted).find((encoder) => encoder['format'] === 'filter');
    expect((filtering?.['fields'] as Record<string, unknown> | undefined)?.['request>uri']).toEqual(
      {
        filter: 'regexp',
        regexp: '\\?.*',
      },
    );
  });

  test('every variable it reads is explained in docs/CONFIG.md', () => {
    const text = readFileSync(DOCKHAND, 'utf8');
    const referenced = new Set(
      [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''),
    );
    expect(referenced.has('PROXY_NETWORK')).toBe(true);
    const undocumented = [...referenced].filter((name) => !config.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });
});
