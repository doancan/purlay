/**
 * A module's migration set on the database the last release left (D-250 rule 6, `MODULES.md` §8).
 *
 *   bun run modules:upgrade
 *
 * `migration-cells.integration.test.ts` migrates every set on an empty database to head, and `upgrade.integration.test.ts`
 * on one schema of the previous release that a person wrote by hand. Neither is a database the last release itself made, so
 * a change to a core migration that breaks a set only where the old schema has rows, or that edits a migration the release
 * already applied, passed both. This takes the release's own migrator — `packages/db` as the last release tag has it,
 * extracted with `git archive` — migrates a database with it, and then migrates a copy of that database with this tree's
 * migrator under each cell's `MODULES` (`moduleCells`, made from the bundle), as a deployment upgrading would.
 *
 * Which databases the release could have left: the one its own `MODULES` made from the cell's modules that the release
 * carried (the same setting an operator keeps through an upgrade), and the one with everything the release carried, which is
 * where a module is turned off by the upgrade. A release that carried no module set knows no `MODULES` and is run without it.
 * A setting the release itself refuses (a module it carried without what it required) is not a database it could have left,
 * and is said, not failed.
 *
 * Pass: every cell's migration exits `0` and records the core's files and its sets' files. The release's files are a
 * prefix of what head records, so a migration of the release that head edited fails here by its checksum.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createDatabase,
  dropDatabases,
  readMigrationFiles,
  sql,
  type MigrationSet,
} from '@purlay/db';
import { bundledModules } from '../composition';
import { moduleCells, type ModuleCell } from './module-cells';

const ROOT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATE = 'packages/db/src/cli/migrate.ts';
/** What the command prints when the migrator refuses a `MODULES` value (`ModulesSettingError`). */
const SETTING_REFUSED = 'MODULES cannot start this process';
const TAIL_LINES = 12;

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The highest release tag by version, not by name (`v0.10.0` is after `v0.9.0`); a pre-release or other tag is not a release. */
export const latestReleaseTag = (tags: readonly string[]): string | undefined => {
  const versioned = tags.flatMap((tag) => {
    const match = RELEASE_TAG.exec(tag);
    return match === null ? [] : [{ tag, parts: match.slice(1).map(Number) }];
  });
  versioned.sort((a, b) => {
    for (let at = 0; at < 3; at += 1) {
      const difference = (b.parts[at] ?? 0) - (a.parts[at] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  });
  return versioned[0]?.tag;
};

/**
 * The `MODULES` value that makes, with the release's migrator, the database an operator running `ids` had: the modules of
 * `ids` the release carried, `none` when there are none, and nothing at all for a release that carried no module (it
 * migrated everything it had).
 */
export const releaseSettingFor = (
  ids: readonly string[],
  releaseIds: readonly string[],
): string | undefined => {
  if (releaseIds.length === 0) return undefined;
  const carried = ids.filter((id) => releaseIds.includes(id));
  return carried.length === 0 ? 'none' : carried.join(',');
};

const urlOn = (base: string, name: string): string => {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
};

interface Ran {
  readonly exitCode: number;
  readonly said: string;
}

const migrateIn = (directory: string, url: string, setting: string | undefined): Ran => {
  const ran = spawnSync(process.execPath, ['--no-env-file', MIGRATE], {
    cwd: directory,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      DATABASE_URL: url,
      ...(setting === undefined ? {} : { MODULES: setting }),
    },
    encoding: 'utf8',
  });
  return { exitCode: ran.status ?? 1, said: `${ran.stdout}${ran.stderr}` };
};

const tail = (said: string): string =>
  said
    .trim()
    .split('\n')
    .slice(-TAIL_LINES)
    .map((line) => `    ${line}`)
    .join('\n');

/** `packages/db` as the release has it, in a directory of its own, run on the dependencies of this tree. */
const extractRelease = (release: string): string => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-release-'));
  const archive = join(directory, 'db.tar');
  const made = spawnSync(
    'git',
    ['archive', '--format=tar', '-o', archive, release, 'packages/db'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  if (made.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`git archive ${release} failed: ${made.stderr.trim()}`);
  }
  const unpacked = spawnSync('tar', ['-xf', archive, '-C', directory], { encoding: 'utf8' });
  if (unpacked.status !== 0) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`tar failed: ${unpacked.stderr.trim()}`);
  }
  return directory;
};

/** The modules the release carried a migration set for: the folders under its `migrations/`. */
const setsOfRelease = (directory: string): string[] =>
  readdirSync(join(directory, 'packages/db/migrations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const namesRecorded = async (url: string): Promise<string[]> => {
  const db = createDatabase({ connectionString: url, poolSize: 1 });
  try {
    const { rows } = await sql<{ name: string }>`select name from kysely_migration`.execute(db);
    return rows.map((row) => row.name);
  } finally {
    await db.destroy();
  }
};

const filesOf = async (sets: readonly MigrationSet[]): Promise<string[]> => [
  ...(await readMigrationFiles()).map((file) => file.name),
  ...(
    await Promise.all(
      sets.map(async (set) => await readMigrationFiles(set.directory, `${set.id}/`)),
    )
  )
    .flat()
    .map((file) => file.name),
];

export interface Upgraded {
  readonly problems: readonly string[];
  readonly notes: readonly string[];
  /** How many (release database, cell) pairs were migrated to head. */
  readonly migrated: number;
}

/**
 * Migrates what the release in `tree` (a directory holding its `packages/db`, `release` its name) left to head, for every
 * cell. `base` is the server's URL; every database is made on it and dropped. The release's migrator runs on the
 * dependencies this tree installed (kysely and pg, in the package's own folder).
 */
export const upgradeFrom = async (
  tree: string,
  release: string,
  base: string,
  cells: readonly ModuleCell[],
): Promise<Upgraded> => {
  const directory = join(tree);
  symlinkSync(join(ROOT, 'packages/db/node_modules'), join(directory, 'packages/db/node_modules'));
  const problems: string[] = [];
  const notes: string[] = [];
  const prefix = `${new URL(base).pathname.slice(1)}_upg_${randomBytes(4).toString('hex')}`;
  const created: string[] = [];
  const admin = createDatabase({ connectionString: urlOn(base, 'postgres'), poolSize: 1 });
  const make = async (name: string, template?: string): Promise<void> => {
    created.push(name);
    await (
      template === undefined
        ? sql`create database ${sql.id(name)}`
        : sql`create database ${sql.id(name)} template ${sql.id(template)}`
    ).execute(admin);
  };
  let migrated = 0;
  try {
    const releaseIds = setsOfRelease(directory);
    const every = releaseSettingFor(
      bundledModules.map((module) => module.manifest.id),
      releaseIds,
    );
    const left = new Map<string | undefined, string | null>();
    const leftBy = async (setting: string | undefined): Promise<string | null> => {
      const known = left.get(setting);
      if (known !== undefined) return known;
      const name = `${prefix}_r${String(left.size)}`;
      await make(name);
      const ran = migrateIn(directory, urlOn(base, name), setting);
      let outcome: string | null = name;
      if (ran.exitCode !== 0) {
        outcome = null;
        if (ran.said.includes(SETTING_REFUSED)) {
          notes.push(`${release} refuses MODULES=${setting ?? '(unset)'}: not a database it left`);
        } else {
          problems.push(
            `${release}'s own migrator failed on an empty database (MODULES=${setting ?? '(unset)'}):\n${tail(ran.said)}`,
          );
        }
      }
      left.set(setting, outcome);
      return outcome;
    };
    for (const cell of cells) {
      const settings = new Set([releaseSettingFor(cell.ids, releaseIds), every]);
      for (const setting of settings) {
        const source = await leftBy(setting);
        if (source === null) continue;
        const clone = `${prefix}_c${String(migrated)}`;
        await make(clone, source);
        const url = urlOn(base, clone);
        const before = await namesRecorded(url);
        if (
          before.length === 0 ||
          before.join() !== (await namesRecorded(urlOn(base, source))).join()
        ) {
          problems.push(`${release}: the copy of the database it left is not what it left`);
          continue;
        }
        const label = `${release} (MODULES=${setting ?? '(unset)'}) to ${cell.label} (MODULES=${cell.setting ?? '(unset)'})`;
        const ran = migrateIn(ROOT, url, cell.setting);
        migrated += 1;
        if (ran.exitCode !== 0) {
          problems.push(`${label}: head's migrator failed:\n${tail(ran.said)}`);
          continue;
        }
        const recorded = new Set(await namesRecorded(url));
        const missing = (await filesOf(cell.composition.migrationSets)).filter(
          (name) => !recorded.has(name),
        );
        if (missing.length > 0) {
          problems.push(`${label}: head left these unrecorded: ${missing.join(', ')}`);
        }
      }
    }
  } finally {
    rmSync(join(directory, 'packages/db/node_modules'), { force: true });
    await admin.destroy();
    await dropDatabases(created);
  }
  return { problems, notes, migrated };
};

export interface Say {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const stdio: Say = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const tagsOf = (): string[] =>
  spawnSync('git', ['tag', '--list'], { cwd: ROOT, encoding: 'utf8' })
    .stdout.split('\n')
    .filter((tag) => tag !== '');

/** The command: the last release tag's database, migrated to head in every cell; `1` for a failure or a missing tag. */
export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  say: Say = stdio,
  tags: () => readonly string[] = tagsOf,
): Promise<number> => {
  const base = environment['DATABASE_URL'] ?? '';
  if (base === '') {
    say.err('modules:upgrade — DATABASE_URL is not set, so nothing was migrated.');
    return 1;
  }
  const release = latestReleaseTag(tags());
  if (release === undefined) {
    say.err(
      'modules:upgrade — no release tag (vX.Y.Z) here, so there is no last release to start from. ' +
        'A shallow checkout needs its tags (`git fetch --tags`).',
    );
    return 1;
  }
  const tree = extractRelease(release);
  let result: Upgraded;
  try {
    result = await upgradeFrom(tree, release, base, moduleCells(bundledModules));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
  for (const note of result.notes) say.out(`note ${note}`);
  if (result.problems.length === 0) {
    say.out(`ok   ${release}: ${String(result.migrated)} upgrades to head, every cell migrated`);
    return 0;
  }
  for (const problem of result.problems) say.err(`FAIL ${problem}`);
  return 1;
};

if (import.meta.main) process.exit(await main(process.env));
