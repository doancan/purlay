/**
 * The image smoke test brings its own database (#231).
 *
 * It used to run the API container against the development compose PostgreSQL through
 * `host.docker.internal`. When the development ports were bound to the loopback address
 * (they should be: the superuser's password is in the repository), a container on the CI
 * runner could no longer reach the database, `migrating on start failed` was the whole of the
 * log, and the `image` check was red on main for three commits without anyone being stopped —
 * because it was not yet a required check. A smoke test that depends on what some other file
 * publishes will break the next time that file is made safer.
 *
 * So it creates a throwaway network and a throwaway PostgreSQL of its own, reached by container
 * name, with nothing published, and removes both when it ends. These tests keep it that way.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const script = readFileSync(join(repo, 'scripts/image-smoke.sh'), 'utf8');
const code = script
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
const workflow = readFileSync(join(repo, '.github/workflows/image.yml'), 'utf8');

describe('scripts/image-smoke.sh', () => {
  test('does not reach the database through the host or the development compose file', () => {
    for (const forbidden of [
      'host.docker.internal',
      'host-gateway',
      'localhost:5432',
      'localhost:${POSTGRES_PORT',
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // It does not read a DATABASE_URL either: there is no database of the host's to point at.
    expect(code).not.toMatch(/DATABASE_URL="\$\{DATABASE_URL/);
  });

  test('creates a private network and a database of its own on it, publishes nothing for the database, and removes both', () => {
    expect(code).toMatch(/docker network create/);
    expect(code).toMatch(/docker run[^\n]*--network/);
    expect(code).toMatch(/docker network rm/);
    // Only the API's port is published (to the loopback address, for the host's curl).
    const publishes = [...code.matchAll(/\s-p\s+"?([^\s"]+)/g)].map((match) => match[1] ?? '');
    expect(publishes).toEqual(['127.0.0.1:$HOST_PORT:3001']);
    expect(code).toMatch(/trap\s+\S+\s+EXIT/);
  });

  test('takes the PostgreSQL image from docker-compose.yml, so it is named in one place', () => {
    const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
    expect(/image:\s*postgres:\S+/.test(compose)).toBe(true);
    expect(code).toContain('docker-compose.yml');
  });
});

describe('the image workflow', () => {
  test('does not start the development database for the smoke test', () => {
    const steps = workflow.split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(steps.join('\n')).not.toMatch(/docker compose up[^\n]*postgres/);
  });
});
