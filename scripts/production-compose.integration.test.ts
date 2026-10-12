import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The production compose file is what the documents say it is (#248, D-94).
 *
 * It asks `docker compose` itself — `config` resolves interpolation, defaults and
 * required variables exactly as `up` would — instead of reading the YAML, because a
 * declared constraint is not an observed one (CONTRIBUTING §6.3). Needs the
 * Docker CLI with the compose plugin; without it this refuses rather than passing,
 * which is why it is an integration test and not part of the fast loop.
 */
const repo = join(import.meta.dir, '..');
const COMPOSE = join(repo, 'docker-compose.production.yml');
const composeText = readFileSync(COMPOSE, 'utf8');
const config = readFileSync(join(repo, 'docs/CONFIG.md'), 'utf8');

/** The proxy image the compose file pins, read from it so the test and the file cannot disagree. */
const PROXY_IMAGE = /image:\s*(caddy:\S+)/.exec(composeText)?.[1] ?? '';

const ENVIRONMENT: Record<string, string> = {
  PURLAY_IMAGE: 'ghcr.io/example/purlay-api@sha256:' + 'a'.repeat(64),
  APP_URL: 'https://chat.example.test',
  POSTGRES_PASSWORD: 'f'.repeat(32),
  GARAGE_RPC_SECRET: 'c'.repeat(64),
  S3_ACCESS_KEY_ID: 'GK' + 'd'.repeat(24),
  S3_SECRET_ACCESS_KEY: 'e'.repeat(64),
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
};

interface Resolved {
  services: Record<
    string,
    {
      image: string;
      read_only?: boolean;
      cap_drop?: string[];
      security_opt?: string[];
      ports?: { published?: string; target: number; protocol?: string }[];
      environment?: Record<string, string>;
      volumes?: { type: string; source?: string; read_only?: boolean }[];
      depends_on?: Record<string, { condition: string }>;
      command?: string[];
      healthcheck?: { disable?: boolean };
      logging?: { driver?: string; options?: Record<string, string> };
    }
  >;
}

/**
 * The caller's environment minus the deployment's variables: a shell variable
 * outranks the env file, so one a developer has exported would hide a missing one.
 */
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !(key in ENVIRONMENT)),
);

const resolve = (
  environment: Record<string, string>,
): { code: number; stdout: string; stderr: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'compose-'));
  try {
    const file = join(directory, 'production.env');
    writeFileSync(
      file,
      Object.entries(environment)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n'),
    );
    const run = Bun.spawnSync(
      ['docker', 'compose', '-f', COMPOSE, '--env-file', file, 'config', '--format', 'json'],
      { stdout: 'pipe', stderr: 'pipe', env: inherited },
    );
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('integration: the production compose file', () => {
  const probe = Bun.spawnSync(['docker', 'compose', 'version'], { stdout: 'pipe', stderr: 'pipe' });
  if (probe.exitCode !== 0) {
    throw new Error(
      'the Docker CLI with the compose plugin is required; without it this would prove nothing',
    );
  }

  const resolved = resolve(ENVIRONMENT);
  if (resolved.code !== 0) throw new Error(`docker compose config failed: ${resolved.stderr}`);
  const model = JSON.parse(resolved.stdout) as Resolved;

  test('resolves with every required variable set', () => {
    expect(resolved.code).toBe(0);
    expect(Object.keys(model.services).sort()).toEqual([
      'api',
      'garage',
      'postgres',
      'proxy',
      'scheduler',
    ]);
  });

  test('every service keeps a bounded log: a server is not filled by its own logs', () => {
    // Docker's json-file driver keeps everything unless told otherwise.
    for (const [name, service] of Object.entries(model.services)) {
      expect({ name, driver: service.logging?.driver }).toEqual({ name, driver: 'json-file' });
      expect(service.logging?.options?.['max-size']).toMatch(/^\d+m$/);
      expect(Number(service.logging?.options?.['max-file'])).toBeGreaterThan(0);
    }
  });

  test('every image but the API is pinned by digest, and the API image is a variable', () => {
    for (const [name, service] of Object.entries(model.services)) {
      if (name === 'api') continue;
      expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(model.services['api']?.image).toBe(ENVIRONMENT['PURLAY_IMAGE'] ?? '');
  });

  test('only the proxy publishes a port, and by default only 80 and 443', () => {
    for (const [name, service] of Object.entries(model.services)) {
      const published = (service.ports ?? []).map((port) => Number(port.published));
      if (name === 'proxy')
        expect([...new Set(published)].sort((a, b) => a - b)).toEqual([80, 443]);
      else expect(published).toEqual([]);
    }
  });

  test('the proxy ports can be moved with HTTP_PORT and HTTPS_PORT, and the origin moves with them', () => {
    const moved = resolve({
      ...ENVIRONMENT,
      HTTP_PORT: '8080',
      HTTPS_PORT: '8443',
      APP_URL: 'https://chat.example.test:8443',
    });
    expect(moved.code).toBe(0);
    const proxy = (JSON.parse(moved.stdout) as Resolved).services['proxy'];
    const published = (proxy?.ports ?? []).map((port) => [Number(port.published), port.target]);
    // The HTTPS port is the same inside and out, because Caddy listens on the port in the
    // site address, which is APP_URL; the HTTP port only redirects, so it is mapped.
    expect(published).toContainEqual([8080, 80]);
    expect(published).toContainEqual([8443, 8443]);
    expect(published.filter(([host]) => host === 80 || host === 443)).toEqual([]);
  });

  test('the proxy does not write the query string of a request to its log', () => {
    // An OAuth callback carries a one-time `code` and the `state` in its query, and a
    // search carries what was searched for. The access log is not a place for either.
    const caddy = Bun.spawnSync(
      [
        'docker',
        'run',
        '--rm',
        '-e',
        'APP_URL=https://localhost',
        '-v',
        `${join(repo, 'docker/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
        PROXY_IMAGE,
        'caddy',
        'adapt',
        '--config',
        '/etc/caddy/Caddyfile',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(caddy.exitCode).toBe(0);
    const adapted = JSON.parse(caddy.stdout.toString()) as {
      logging?: {
        logs?: Record<string, { encoder?: { format?: string; fields?: Record<string, unknown> } }>;
      };
    };
    const encoders = Object.values(adapted.logging?.logs ?? {}).flatMap((log) => log.encoder ?? []);
    const filtering = encoders.find((encoder) => encoder.format === 'filter');
    expect(filtering).toBeDefined();
    // Everything from the `?` on is removed from the logged URI.
    expect(filtering?.fields?.['request>uri']).toEqual({ filter: 'regexp', regexp: '\\?.*' });
  });

  test('the API runs read-only, without capabilities or privilege escalation, and migrates itself', () => {
    const api = model.services['api'];
    expect(api?.read_only).toBe(true);
    expect(api?.cap_drop).toEqual(['ALL']);
    expect(api?.security_opt).toContain('no-new-privileges:true');
    expect(api?.environment?.['MIGRATE_ON_START']).toBe('true');
    expect(api?.environment?.['NODE_ENV']).toBe('production');
    // Production refuses an unencrypted database link unless told it is private (D-79).
    expect(api?.environment?.['DATABASE_SSL']).toBe('false');
    expect(api?.environment?.['DATABASE_ALLOW_PLAINTEXT']).toBe('true');
    expect(api?.environment?.['APP_URL']).toBe(ENVIRONMENT['APP_URL'] ?? '');
    expect(api?.environment?.['DATABASE_URL']).toBe(
      `postgres://purlay:${ENVIRONMENT['POSTGRES_PASSWORD'] ?? ''}@postgres:5432/purlay`,
    );
  });

  test('the scheduler ships with it (D-30): the same image and settings, hardened, after a ready API', () => {
    const scheduler = model.services['scheduler'];
    const api = model.services['api'];
    expect(scheduler?.image).toBe(api?.image ?? '');
    expect(scheduler?.command).toEqual(['apps/api/src/cli/schedule.ts']);
    // The jobs read the API's configuration: the same database, bucket and keys, not a copy that drifts.
    for (const key of [
      'DATABASE_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY_ID',
      'ENCRYPTION_KEY',
      'NODE_ENV',
    ]) {
      expect({ key, value: scheduler?.environment?.[key] }).toEqual({
        key,
        value: api?.environment?.[key],
      });
    }
    // The API migrates; the scheduler starts after it is ready, and never migrates itself.
    expect(scheduler?.environment?.['MIGRATE_ON_START']).not.toBe('true');
    expect(scheduler?.depends_on?.['api']?.condition).toBe('service_healthy');
    expect(scheduler?.read_only).toBe(true);
    expect(scheduler?.cap_drop).toEqual(['ALL']);
    expect(scheduler?.security_opt).toContain('no-new-privileges:true');
    expect(scheduler?.ports ?? []).toEqual([]);
    // The image's healthcheck asks the API's port, which this container does not open.
    expect(scheduler?.healthcheck?.disable).toBe(true);
  });

  test('the proxy waits for a ready API, and the API for a healthy database and store', () => {
    expect(model.services['proxy']?.depends_on?.['api']?.condition).toBe('service_healthy');
    expect(model.services['api']?.depends_on?.['postgres']?.condition).toBe('service_healthy');
    expect(model.services['api']?.depends_on?.['garage']?.condition).toBe('service_healthy');
  });

  test('nothing assumes this server: the only host paths are read-only files from this repository', () => {
    for (const service of Object.values(model.services)) {
      for (const volume of service.volumes ?? []) {
        if (volume.type !== 'bind') continue;
        expect(volume.read_only).toBe(true);
        expect(volume.source?.startsWith(join(repo, 'docker') + '/')).toBe(true);
      }
    }
  });

  test('every variable it reads is explained in docs/CONFIG.md', () => {
    const code = composeText
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const referenced = new Set(
      [...code.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''),
    );
    // The positive condition: it does read some.
    expect(referenced.size).toBeGreaterThan(0);

    const passed = Object.keys(model.services['api']?.environment ?? {});
    const undocumented = [...referenced, ...passed].filter(
      (name) => !config.includes(`\`${name}\``),
    );
    expect(undocumented).toEqual([]);
  });

  describe('docker/production.env.example', () => {
    const lines = readFileSync(join(repo, 'docker/production.env.example'), 'utf8').split('\n');
    const code = composeText
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    const referenced = new Set(
      [...code.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((match) => match[1] ?? ''),
    );
    const required = new Set(
      [...code.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)].map((match) => match[1] ?? ''),
    );
    const active = Object.fromEntries(
      lines
        .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const optional = lines.flatMap((line) => /^#\s?([A-Z][A-Z0-9_]*)=/.exec(line)?.[1] ?? []);

    test('sets exactly the variables the stack requires, and lists the rest as comments', () => {
      expect(required.size).toBeGreaterThan(0);
      expect(Object.keys(active).sort()).toEqual([...required].sort());
      expect([...optional].sort()).toEqual(
        [...referenced].filter((name) => !required.has(name)).sort(),
      );
    });

    test('left as it is, it stops docker compose and names a variable: no secret is pre-filled', () => {
      const bare = Object.fromEntries(Object.entries(active).map(([name, value]) => [name, value]));
      const result = resolve(bare);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/set [A-Z_]+/);
      for (const name of [
        'POSTGRES_PASSWORD',
        'GARAGE_RPC_SECRET',
        'S3_SECRET_ACCESS_KEY',
        'ENCRYPTION_KEY',
      ]) {
        expect(active[name]).toBe('');
      }
    });

    test('with the empty values filled in it resolves', () => {
      const filled = Object.fromEntries(
        Object.entries(active).map(([name, value]) => [
          name,
          value === '' ? (ENVIRONMENT[name] ?? '') : value,
        ]),
      );
      const result = resolve({ ...filled, PURLAY_IMAGE: ENVIRONMENT['PURLAY_IMAGE'] ?? '' });
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    });
  });

  test.each(Object.keys(ENVIRONMENT))(
    'a missing %s stops `docker compose` and names it',
    (name) => {
      const without = Object.entries(ENVIRONMENT).filter(([key]) => key !== name);
      const result = resolve(Object.fromEntries(without));
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(name);
    },
  );
});
