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
    expect(Object.keys(model.services).sort()).toEqual(['api', 'garage', 'postgres', 'proxy']);
  });

  test('every image but the API is pinned by digest, and the API image is a variable', () => {
    for (const [name, service] of Object.entries(model.services)) {
      if (name === 'api') continue;
      expect(service.image).toMatch(/@sha256:[0-9a-f]{64}$/);
    }
    expect(model.services['api']?.image).toBe(ENVIRONMENT['PURLAY_IMAGE'] ?? '');
  });

  test('only the proxy publishes a port, and only 80 and 443', () => {
    for (const [name, service] of Object.entries(model.services)) {
      const published = (service.ports ?? []).map((port) => Number(port.published));
      if (name === 'proxy')
        expect([...new Set(published)].sort((a, b) => a - b)).toEqual([80, 443]);
      else expect(published).toEqual([]);
    }
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
