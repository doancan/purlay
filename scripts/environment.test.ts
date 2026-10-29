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
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const compose = readFileSync('docker-compose.yml', 'utf8');

const images = [...compose.matchAll(/^\s+image:\s*(\S+)$/gm)].map((m) => m[1] ?? '');

describe('the development environment', () => {
  test('declares images at all', () => {
    expect(images.length).toBeGreaterThanOrEqual(2);
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
   *
   * Garage's image has no shell, so the bucket is made by a script on the host.
   * The script is what is bound: it creates the bucket, never enables a website
   * on it, and fails if the published port does not refuse an anonymous read.
   */
  test('the attachment bucket is created by the script, and never made public', () => {
    const script = readFileSync('scripts/storage-init.sh', 'utf8');
    expect(script).toContain('garage bucket create "$BUCKET"');
    expect(script).toContain('403');
    expect(script).not.toContain('bucket website');
    expect(readFileSync('package.json', 'utf8')).toContain('./scripts/storage-init.sh');
  });

  /**
   * 5432 and 9000 are conventional and frequently already taken. A port
   * collision is exactly the friction that turns "self-hosts it from the README"
   * into a support ticket. (`PRD.md` §3, S-2)
   */
  test('host ports can be overridden without editing the file', () => {
    for (const variable of ['POSTGRES_PORT', 'STORAGE_PORT']) {
      expect(compose).toContain(`\${${variable}:-`);
    }
  });

  /**
   * The development database has a superuser with a password the repository publishes,
   * and the object store a key the same. A port published as `5432:5432` listens on
   * every interface, so anyone on the same network could connect with them (found by an
   * audit that ran `nc -z` against the machine's LAN address). Every mapping is bound
   * to the loopback address, and a new service cannot be added without one.
   */
  test('every published port is bound to the loopback address', () => {
    const mappings = [...compose.matchAll(/^\s+-\s+['"]?([^'"\s#]+:\d+(?:\/\w+)?)['"]?/gm)].map(
      (match) => match[1] ?? '',
    );
    // The positive condition: there are mappings to judge, and both services have one.
    expect(
      mappings.filter((mapping) => /\$\{POSTGRES_PORT|\$\{STORAGE_PORT/.test(mapping)),
    ).toHaveLength(2);
    expect(mappings.filter((mapping) => !mapping.startsWith('127.0.0.1:'))).toEqual([]);
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

  test('every workflow reads the Bun version rather than repeating it', () => {
    const workflows = readdirSync('.github/workflows')
      .filter((name) => name.endsWith('.yml'))
      .map((name) => readFileSync(join('.github/workflows', name), 'utf8'))
      .filter((workflow) => workflow.includes('setup-bun'));
    expect(workflows.length).toBeGreaterThan(0);
    for (const workflow of workflows) {
      expect(workflow).toContain('bun-version-file: package.json');
      expect(workflow).not.toMatch(/bun-version:\s*\d/);
    }
  });

  /** The pipeline runs each browser project as a job of its own; a project added to one is run by both. */
  test('the browser job runs every project the browser tests define, and no other', () => {
    const config = readFileSync('apps/web/playwright.config.ts', 'utf8');
    const block = /const projects = \[([\s\S]*?)\] as const;/.exec(config)?.[1] ?? '';
    const defined = [...block.matchAll(/name: '([^']+)'/g)].map((match) => match[1] ?? '');
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
    const listed = /^ {8}project: \[([^\]]*)\]$/m
      .exec(workflow)?.[1]
      ?.split(',')
      .map((name) => name.trim());
    expect(defined.length).toBeGreaterThan(0);
    expect(listed).toEqual(defined);
  });

  /** An image cannot read package.json, so its tag repeats the version; this keeps the two equal. */
  test('every Bun base image is the version packageManager names', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { packageManager: string };
    const runtime = /^bun@(.+)$/.exec(pkg.packageManager)?.[1] ?? '';
    const tags = [
      ...readFileSync('Dockerfile', 'utf8').matchAll(/^FROM oven\/bun:([^@\s-]+)/gm),
    ].map((match) => match[1]);
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set([runtime]));
  });

  /**
   * The port defaults exist in the compose file and are documented in
   * `CONFIG.md`. Both are useful — one is the behaviour, the other explains it —
   * so they are bound rather than reduced to one.
   */
  test('the documented port defaults are the ones the compose file uses', () => {
    const config = readFileSync('docs/CONFIG.md', 'utf8');
    for (const variable of ['POSTGRES_PORT', 'STORAGE_PORT']) {
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
      expect(block).toContain('healthcheck:');
    }
  });
});

test('every suite entry point isolates file globals', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  expect(pkg.scripts['test']).toContain('test apps packages scripts --isolate ');
  expect(pkg.scripts['test:integration']).toContain('test apps packages scripts --isolate ');
  for (const runner of ['scripts/test-all.ts', 'scripts/mutate.ts']) {
    expect(readFileSync(runner, 'utf8')).toMatch(/'test',\s*'--isolate'/);
  }
});
