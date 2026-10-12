/**
 * The image is what the documents say it is (#248, D-87): every base pinned by
 * digest, a numeric non-root user, a health check on the real readiness endpoint,
 * and a build context that cannot carry a secret.
 *
 * A declared constraint is not an observed one — the container itself was built
 * and run against a database for the pull request that added this — but these are
 * the properties a later edit can lose without any test noticing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const dockerfile = readFileSync(join(repo, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(join(repo, '.dockerignore'), 'utf8');

/** The `FROM` references that are not pinned by a sha256 digest. */
const unpinnedBases = (text: string): readonly string[] =>
  text
    .split('\n')
    .flatMap((line) => /^FROM\s+(\S+)/i.exec(line)?.[1] ?? [])
    .filter((reference) => !/@sha256:[0-9a-f]{64}$/.test(reference));

describe('the Dockerfile', () => {
  test('the checker reports a tag-only base and a short digest', () => {
    expect(unpinnedBases('FROM oven/bun:1.4.2-slim AS a')).toEqual(['oven/bun:1.4.2-slim']);
    expect(unpinnedBases(`FROM oven/bun@sha256:${'a'.repeat(63)}`)).toHaveLength(1);
    expect(unpinnedBases(`FROM oven/bun:1@sha256:${'a'.repeat(64)} AS ok`)).toEqual([]);
  });

  test('has stages to judge, each pinned by digest', () => {
    expect(dockerfile.match(/^FROM\s/gim)?.length).toBeGreaterThanOrEqual(2);
    expect(unpinnedBases(dockerfile)).toEqual([]);
  });

  test('the final stage runs as a numeric non-root user', () => {
    const final = dockerfile.slice(dockerfile.toUpperCase().lastIndexOf('\nFROM '));
    const user = /^USER\s+(\d+)(?::(\d+))?\s*$/m.exec(final);
    expect(user).not.toBeNull();
    expect(Number(user?.[1])).toBeGreaterThan(0);
  });

  test('the health check asks the readiness endpoint, and the image keeps no shell for it', () => {
    expect(dockerfile).toMatch(/^HEALTHCHECK[\s\S]*\/health\/ready/m);
    // exec form: the runtime image has no shell to interpret a string
    expect(dockerfile).toMatch(/CMD \["\/usr\/local\/bin\/bun", "-e"/);
    expect(dockerfile).not.toMatch(/^\s*RUN\b.*\b(apt-get|apk|curl|wget)\b/m);
  });

  test('installs only what the lockfile names, production only', () => {
    expect(dockerfile).toMatch(/bun install --frozen-lockfile --production/);
  });

  test('is copied from explicit paths, never from the whole context', () => {
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/m);
  });
});

/** Every workspace in the repository: each directory under `apps/` and `packages/` with a manifest. */
const workspaces = (): readonly string[] =>
  ['apps', 'packages'].flatMap((root) =>
    readdirSync(join(repo, root))
      .map((name) => `${root}/${name}`)
      .filter((dir) => existsSync(join(repo, dir, 'package.json'))),
  );

/** The workspaces whose manifest the stage that installs does not copy. */
const uncopiedManifests = (text: string, dirs: readonly string[]): readonly string[] => {
  const install = text.slice(0, text.search(/^RUN bun install/m));
  return dirs.filter((dir) => !install.includes(`COPY ${dir}/package.json ${dir}/package.json`));
};

// `--frozen-lockfile` refuses a checkout that lacks any workspace another one depends on. The tokens
// manifest was missing for as long as CI could not run, so the image did not build at all (#326).
describe('the install stage', () => {
  test('the checker reports a manifest that is not copied', () => {
    const one = 'COPY apps/api/package.json apps/api/package.json\nRUN bun install\n';
    expect(uncopiedManifests(one, ['apps/api', 'packages/tokens'])).toEqual(['packages/tokens']);
  });

  test('copies the manifest of every workspace, before it installs', () => {
    expect(workspaces().length).toBeGreaterThan(5);
    expect(uncopiedManifests(dockerfile, workspaces())).toEqual([]);
  });
});

/**
 * The paths the Dockerfile copies from the context that `.dockerignore` keeps out of it.
 * Patterns are matched as patterns, anchored at the root as the builder anchors them, and
 * a directory excluded excludes what is under it; every source of a `COPY` is judged.
 */
const excludedCopies = (ignore: string, file: string): readonly string[] => {
  const rules = ignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => ({ include: line.startsWith('!'), pattern: line.replace(/^!/, '') }));
  const matches = (pattern: string, path: string): boolean =>
    new Bun.Glob(pattern).match(path) || path.startsWith(`${pattern}/`);
  const sources = [...file.matchAll(/^COPY\s+(?!--from=)(.+)$/gm)].flatMap((match) =>
    (match[1] ?? '').split(/\s+/).slice(0, -1),
  );
  // The last rule that matches decides, as the builder decides: `!x` after `dir/*` keeps x.
  return sources
    .map((path) => path.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter((path) => rules.findLast((rule) => matches(rule.pattern, path))?.include === false);
};

describe('.dockerignore', () => {
  test.each([
    '.env',
    '.git',
    'node_modules',
    '*.pem',
    '.claude',
    '**/*.test.ts',
    'apps/api/src/testing',
    'apps/api/src/cli/demo-*.ts',
    'apps/api/src/cli/seed-demo.ts',
  ])('keeps %s out of the context', (entry) => {
    expect(dockerignore.split('\n')).toContain(entry);
  });

  test('the checker sees a pattern, not only a line equal to the path', () => {
    // `apps/web/*` excluded the client's sources while a check that compared lines passed.
    expect(excludedCopies('apps/web/*\n', 'COPY apps/web/src ./apps/web/src\n')).toEqual([
      'apps/web/src',
    ]);
    expect(excludedCopies('apps/web/e2e\n', 'COPY a b apps/web/e2e/x ./\n')).toEqual([
      'apps/web/e2e/x',
    ]);
    expect(excludedCopies('docs\n', 'COPY --from=client /app/x ./x\n')).toEqual([]);
    expect(
      excludedCopies('apps/web/*\n!apps/web/package.json\n', 'COPY apps/web/package.json x\n'),
    ).toEqual([]);
  });

  test('does not exclude what the Dockerfile copies', () => {
    expect(excludedCopies(dockerignore, dockerfile)).toEqual([]);
  });
});
