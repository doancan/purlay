/**
 * Which pull requests run the image build and the restore rehearsal (#231).
 *
 * Both workflows run on every pull request so that they can be required checks; this decides
 * whether the job has anything to do. The patterns live in the workflows, so the test reads
 * them from there — a copy here would be one more thing to keep in step.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const script = join(repo, 'scripts/pr-touches.sh');

const decide = (pattern: string, files: readonly string[]): string => {
  const run = Bun.spawnSync(['bash', script, pattern], {
    stdin: new TextEncoder().encode(files.join('\n')),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(run.stderr.toString()).toBe('');
  return run.stdout.toString().trim();
};

/** The pattern a workflow passes, from its `PATTERN:` environment entry. */
const patternOf = (workflow: string): string => {
  const text = readFileSync(join(repo, '.github/workflows', workflow), 'utf8');
  const match = /^\s+PATTERN:\s*'(.+)'\s*$/m.exec(text);
  if (match?.[1] === undefined) throw new Error(`${workflow} declares no PATTERN`);
  return match[1];
};

describe('pr-touches.sh', () => {
  test('is true when any changed file matches, false when none does', () => {
    expect(decide('^Dockerfile$', ['README.md', 'Dockerfile'])).toBe('relevant=true');
    expect(decide('^Dockerfile$', ['README.md', 'docs/OVERVIEW.md'])).toBe('relevant=false');
  });

  test('an empty listing is a pull request it could not read, and fails closed', () => {
    expect(decide('^Dockerfile$', [])).toBe('relevant=true');
  });

  test('a pattern that starts with a dash is a pattern, not an option', () => {
    expect(decide('-x', ['-x'])).toBe('relevant=true');
  });
});

describe('what each workflow runs for', () => {
  const image = patternOf('image.yml');
  const rehearsal = patternOf('restore-rehearsal.yml');

  test.each([
    'Dockerfile',
    '.dockerignore',
    '.github/workflows/image.yml',
    'apps/api/src/index.ts',
    'packages/db/src/migrator.ts',
    'packages/types/src/index.ts',
    'bun.lock',
    'package.json',
    'scripts/image-smoke.sh',
    'docker-compose.production.yml',
  ])('a change to %s runs the image build', (path) => {
    expect(decide(image, [path])).toBe('relevant=true');
  });

  test.each(['docs/DECISIONS.md', 'apps/web/src/main.tsx', 'README.md'])(
    'a change to %s alone does not',
    (path) => {
      expect(decide(image, [path])).toBe('relevant=false');
    },
  );

  test.each([
    'scripts/backup.sh',
    'scripts/restore.sh',
    'scripts/compare-databases.sh',
    'scripts/ops-common.sh',
    'scripts/restore-pitr.sh',
    'scripts/prune-wal.sh',
    'scripts/check-backup.sh',
    'docker/postgres-start.sh',
    'docker/wal-archive.sh',
    'scripts/production-init.sh',
    'scripts/restore-rehearsal.sh',
    'scripts/rehearsal-seed-bucket.ts',
    'scripts/bucket-copy.ts',
    'docs/spikes/backup-restore.seed.sql',
    'docker-compose.production.yml',
    'docker/garage.production.toml',
    'Dockerfile',
    'packages/db/migrations/0011_x.sql',
    '.github/workflows/restore-rehearsal.yml',
  ])('a change to %s runs the restore rehearsal', (path) => {
    expect(decide(rehearsal, [path])).toBe('relevant=true');
  });

  test('a change to a document alone does not run the rehearsal', () => {
    expect(decide(rehearsal, ['docs/DECISIONS.md', 'apps/web/src/main.tsx'])).toBe(
      'relevant=false',
    );
  });
});
