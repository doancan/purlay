import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Dockhand compose file is the production stack in one file, behind Nginx Proxy Manager (D-258).
 *
 * Like `production-compose.integration.test.ts`, it asks `docker compose config` rather than reading the
 * YAML. Its main job is to hold the two files equal everywhere they are meant to be equal, so a change to
 * the production stack that is not made here fails here, and to pin the few ways they differ: no Caddy,
 * the API's port published for Nginx Proxy Manager, no WAL archiving.
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
  PURLAY_HTTP_PORT: '8190',
};

type Service = Record<string, unknown> & {
  image?: string;
  ports?: unknown[];
  volumes?: { type: string; source?: string; target?: string }[];
  configs?: { source: string; target: string }[];
  environment?: Record<string, string>;
  entrypoint?: string[];
};
interface Resolved {
  services: Record<string, Service>;
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

describe('integration: the Dockhand compose file', () => {
  const probe = Bun.spawnSync(['docker', 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' });
  if (probe.exitCode !== 0) {
    throw new Error(
      'the Docker CLI with the compose plugin is required; without it this would prove nothing',
    );
  }

  const dockhand = model(DOCKHAND);
  const production = model(PRODUCTION);
  test('has the services of the production stack but its Caddy, no more and no fewer', () => {
    expect(Object.keys(dockhand.services).sort()).toEqual(
      Object.keys(production.services)
        .filter((name) => name !== 'proxy')
        .sort(),
    );
  });

  test('the API is production’s exactly, but for its one published port', () => {
    expect(without(dockhand.services['api'], 'networks', 'ports')).toEqual(
      without(production.services['api'], 'networks', 'ports'),
    );
    // Nginx Proxy Manager is the one proxy TRUST_PROXY means (D-81), as Caddy was.
    expect(dockhand.services['api']?.environment?.['TRUST_PROXY']).toBe('true');
  });

  test('the scheduler and the store’s preparation are the production ones exactly', () => {
    for (const name of ['scheduler', 'storage-init']) {
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

  test('only the API publishes a port: PURLAY_HTTP_PORT, on every address unless PURLAY_HTTP_BIND says', () => {
    for (const [name, service] of Object.entries(dockhand.services)) {
      if (name === 'api') continue;
      expect({ name, ports: service.ports ?? [] }).toEqual({ name, ports: [] });
    }
    expect(dockhand.services['api']?.ports).toEqual([
      expect.objectContaining({
        host_ip: '0.0.0.0',
        published: '8190',
        target: 3001,
        protocol: 'tcp',
      }),
    ]);
    const bound = resolve(DOCKHAND, { ...ENVIRONMENT, PURLAY_HTTP_BIND: '10.0.0.34' });
    expect(bound.code).toBe(0);
    expect((JSON.parse(bound.stdout) as Resolved).services['api']?.ports).toEqual([
      expect.objectContaining({ host_ip: '10.0.0.34', published: '8190', target: 3001 }),
    ]);
  });

  test('without PURLAY_HTTP_PORT it stops and names it', () => {
    const rest = Object.fromEntries(
      Object.entries(ENVIRONMENT).filter(([name]) => name !== 'PURLAY_HTTP_PORT'),
    );
    const missing = resolve(DOCKHAND, rest);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('PURLAY_HTTP_PORT');
  });

  test('every variable it reads is explained in docs/CONFIG.md', () => {
    const text = readFileSync(DOCKHAND, 'utf8');
    const referenced = new Set(
      [...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''),
    );
    expect(referenced.has('PURLAY_HTTP_PORT')).toBe(true);
    const undocumented = [...referenced].filter((name) => !config.includes(`\`${name}\``));
    expect(undocumented).toEqual([]);
  });
});
