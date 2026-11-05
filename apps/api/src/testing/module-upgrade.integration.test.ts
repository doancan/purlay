import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIntegrationDatabase } from '@purlay/db';
import { bundledModules } from '../composition';
import { moduleCells } from './module-cells';
import { upgradeFrom } from './module-upgrade';

const base = process.env['DATABASE_URL'];
if (base === undefined || base === '') {
  throw new Error('DATABASE_URL is not set, so these tests would silently prove nothing.');
}

const ROOT = join(import.meta.dir, '../../../..');
const trees: string[] = [];

afterAll(async () => {
  for (const tree of trees) rmSync(tree, { recursive: true, force: true });
  await closeIntegrationDatabase();
});

const newest = (directory: string): string | undefined =>
  readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .at(-1);

/**
 * A release as old as this tree less its newest migrations: the newest of the core's and of each set that has more than
 * one, so what head must apply on top is real, and no migration number is written here to go stale.
 */
const olderRelease = (): string => {
  const tree = mkdtempSync(join(tmpdir(), 'purlay-older-release-'));
  trees.push(tree);
  cpSync(join(ROOT, 'packages/db'), join(tree, 'packages/db'), {
    recursive: true,
    filter: (source) => !source.includes('node_modules'),
  });
  const migrations = join(tree, 'packages/db/migrations');
  const folders = [
    migrations,
    ...readdirSync(migrations, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(migrations, entry.name)),
  ];
  for (const folder of folders) {
    const last = newest(folder);
    const files = readdirSync(folder).filter((file) => file.endsWith('.sql'));
    if (last !== undefined && (folder === migrations || files.length > 1)) {
      rmSync(join(folder, last));
    }
  }
  return tree;
};

describe('integration: every set on the database the last release left', () => {
  // `bun run modules:upgrade` (CI's `modules` job) does the same from the last release tag, extracted with `git archive`;
  // a test cannot rely on a tag being there, so the release here is this tree less its newest migrations.
  test('a database the older release made, with its own migrator, is migrated to head in every cell', async () => {
    const cells = moduleCells(bundledModules);
    const result = await upgradeFrom(olderRelease(), 'an older release', base, cells);
    expect(result.problems).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.migrated).toBeGreaterThanOrEqual(cells.length);
  }, 120_000);

  test('a migration of the release that head has edited is refused, naming the migration', async () => {
    const tree = olderRelease();
    const identity = join(tree, 'packages/db/migrations/0002_identity.sql');
    await Bun.write(
      identity,
      `${await Bun.file(identity).text()}\n-- edited after it was applied\n`,
    );
    const result = await upgradeFrom(tree, 'an edited release', base, moduleCells(bundledModules));
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.join('\n')).toContain('0002_identity');
  }, 120_000);
});
