/**
 * The local environment, bound to the documents that own it.
 *
 * `docker-compose.yml` is a seventh place a version could live, and the last
 * consistency pass found four stale PostgreSQL references left behind by an
 * upgrade that touched only two of six. `ARCHITECTURE.md` §2 owns the stack;
 * this asserts the environment agrees with it rather than drifting quietly.
 * (D-20, D-49)
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const compose = readFileSync('docker-compose.yml', 'utf8');

const images = [...compose.matchAll(/^\s+image:\s*(\S+)$/gm)].map((m) => m[1] ?? '');

describe('the development environment', () => {
  test('declares images at all', () => {
    expect(images.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * A floating tag makes "target the latest stable major, and say so" untrue the
   * first time upstream moves, and it moves without a commit. Dependency updates
   * arrive as pull requests through the same gate as everything else (D-20).
   */
  test('every image is pinned — no floating tag', () => {
    for (const image of images) {
      expect(image).toContain(':');
      expect(image.endsWith(':latest')).toBe(false);
    }
  });

  /**
   * There used to be a test here binding the compose image to a major number
   * written in `ARCHITECTURE.md` §2. The document no longer carries one (D-56):
   * the image tag *is* the fact, so there is nothing left to bind it to. What
   * remains of its job — no document may name a version — is `check-docs.py`,
   * which now applies that rule to `ARCHITECTURE.md` as well.
   */
  test('the database image names an explicit major, not a moving one', () => {
    const used = images.find((i) => i.startsWith('postgres:'));
    expect(used).toBeDefined();
    expect(used).toMatch(/^postgres:\d+/);
  });

  /**
   * PostgreSQL 18+ wants a single mount at /var/lib/postgresql, so the data
   * directory sits inside the volume and a later `pg_upgrade --link` does not
   * cross a mount boundary. Mounting .../data works until the first major
   * upgrade — which, for a self-hosted product, is an operator's problem we
   * would have created.
   */
  test('the data volume is mounted where a major upgrade can survive it', () => {
    expect(compose).toContain('postgres-data:/var/lib/postgresql\n');
    expect(compose).not.toContain('postgres-data:/var/lib/postgresql/data');
  });

  /**
   * Attachments are stored under opaque keys and never served as public URLs;
   * downloads are brokered by the API so membership is actually checked.
   * (D-16, ARCHITECTURE.md §9)
   */
  test('the attachment bucket is created private', () => {
    expect(compose).toContain('mc mb --ignore-existing local/purlay-attachments');
    expect(compose).toContain('mc anonymous set none local/purlay-attachments');
  });

  /**
   * 5432 and 9000 are conventional and frequently already taken. A port
   * collision is exactly the friction that turns "self-hosts it from the README"
   * into a support ticket. (`PRD.md` §3, S-2)
   */
  test('host ports can be overridden without editing the file', () => {
    for (const variable of ['POSTGRES_PORT', 'MINIO_PORT', 'MINIO_CONSOLE_PORT']) {
      expect(compose).toContain(`\${${variable}:-`);
    }
  });

  /**
   * The development credentials exist in the compose file; the schema check
   * defaults to them. Two places, bound rather than trusted — the sweep that
   * found this also found the Bun version pinned in five.
   */
  test('everything that needs the development credentials agrees with the compose file', () => {
    const user = /POSTGRES_USER:\s*(\S+)/.exec(compose)?.[1];
    const password = /POSTGRES_PASSWORD:\s*(\S+)/.exec(compose)?.[1];
    const database = /POSTGRES_DB:\s*(\S+)/.exec(compose)?.[1];
    expect(user).toBeDefined();

    const prefix = `postgres://${user ?? ''}:${password ?? ''}@localhost:`;

    // The schema check defaults to them for local use…
    const script = readFileSync('scripts/check-schema.sh', 'utf8');
    expect(script).toContain(prefix);
    expect(script).toContain(`/${database ?? ''}"`);

    // …and the pipeline declares them once for the job that needs a database.
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain(`${prefix}5432/${database ?? ''}`);
  });

  /** `packageManager` is the source; the type package must not drift from it. */
  test('the Bun runtime and its types are the same version', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      packageManager: string;
      devDependencies: Record<string, string>;
    };
    const runtime = /^bun@(.+)$/.exec(pkg.packageManager)?.[1];
    expect(runtime).toBeDefined();
    expect(pkg.devDependencies['@types/bun']).toBe(runtime ?? '');
  });

  test('the pipeline reads the Bun version rather than repeating it', () => {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(workflow).toContain('bun-version-file: package.json');
    expect(workflow).not.toMatch(/bun-version:\s*\d/);
  });

  /**
   * The port defaults exist in the compose file and are documented in
   * `CONFIG.md`. Both are useful — one is the behaviour, the other explains it —
   * so they are bound rather than reduced to one.
   */
  test('the documented port defaults are the ones the compose file uses', () => {
    const config = readFileSync('docs/CONFIG.md', 'utf8');
    for (const variable of ['POSTGRES_PORT', 'MINIO_PORT', 'MINIO_CONSOLE_PORT']) {
      const used = new RegExp(`\\$\\{${variable}:-(\\d+)\\}`).exec(compose)?.[1];
      expect(used).toBeDefined();
      expect(config).toContain(`\`${variable}\` | \`${used ?? ''}\``);
    }
  });

  test('every service defines readiness, so a cold start is deterministic', () => {
    const services = (/^services:\n([\s\S]*?)\nvolumes:/m.exec(compose)?.[1] ?? '')
      .split(/\n  (?=[a-z])/)
      .filter((block) => block.includes('image:'));
    for (const block of services) {
      // The one-shot bucket container exits; readiness is meaningless for it.
      if (block.includes('minio/mc')) continue;
      expect(block).toContain('healthcheck:');
    }
  });
});
