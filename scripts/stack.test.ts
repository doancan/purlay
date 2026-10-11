/**
 * The stack table describes this repository, or the build fails.
 *
 * Turborepo sat in `ARCHITECTURE.md` §2 for months with nothing installed, and
 * `React 19` sat there while nothing had installed React (D-55, D-56). Neither
 * was catchable: the table said what the project had *chosen*, and nothing
 * compared that to what it *had*.
 *
 * The third column closes it, in both directions. A cell naming packages must
 * resolve every one of them; a cell saying `not yet` names them too and they
 * must be **absent**, so a row cannot quietly stay behind after its thing is
 * installed. (D-59)
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

interface Row {
  readonly layer: string;
  readonly status: string;
  readonly names: readonly string[];
}

const MARKERS = ['built in', 'none, on purpose', 'not yet', 'undecided'] as const;

const stackRows = (): readonly Row[] => {
  const lines = readFileSync('docs/ARCHITECTURE.md', 'utf8').split('\n');
  const header = lines.findIndex((line) => line.startsWith('| Layer | Choice | In the repo |'));
  expect(header).toBeGreaterThan(-1);
  const rows: Row[] = [];
  for (let i = header + 2; lines[i]?.startsWith('|') === true; i += 1) {
    const cells = (lines[i] ?? '').split('|');
    const status = (cells[3] ?? '').trim();
    rows.push({
      layer: (cells[1] ?? '').trim(),
      status,
      names: [...status.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ''),
    });
  }
  return rows;
};

/** Every dependency this repository installs, from every manifest. */
const installed = (): ReadonlySet<string> => {
  const manifests = Bun.spawnSync([
    'bash',
    '-lc',
    'ls package.json apps/*/package.json packages/*/package.json',
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean);
  const names = new Set<string>();
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const name of Object.keys(pkg[field] ?? {})) {
        if (!name.startsWith('@purlay/')) names.add(name);
      }
    }
  }
  return names;
};

/** Services the local environment actually runs. */
const services = (): ReadonlySet<string> => {
  const compose = readFileSync('docker-compose.yml', 'utf8');
  const found = [...compose.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((match) => match[1] ?? '');
  return new Set(found);
};

const rows = stackRows();
const packages = installed();
const running = services();

/** A trailing `*` is a scope: `@radix-ui/*` matches any package under it. */
const present = (name: string): boolean =>
  name.endsWith('*')
    ? [...packages].some((installedName) => installedName.startsWith(name.slice(0, -1)))
    : packages.has(name) || running.has(name);

/** What is wrong with a row: empty when the row is true of this repository. */
const problemsOf = (row: Row): readonly string[] => {
  const isMarker = MARKERS.some((marker) => row.status.startsWith(marker));
  if (!isMarker && row.names.length === 0) return ['names nothing and is no marker'];
  if (row.status.startsWith('not yet')) {
    // Named, so the row cannot stay behind once the thing is installed.
    if (row.names.length === 0) return ['says not yet and names nothing'];
    return row.names.filter(present).map((name) => `says not yet, but ${name} is installed`);
  }
  if (row.status.startsWith('undecided')) {
    // Nothing to install, so something must be watching for the decision.
    return /(#\d+|O-\d+)/.test(row.status) ? [] : ['undecided with no issue or open question'];
  }
  return row.names.filter((name) => !present(name)).map((name) => `${name} is not installed`);
};

describe('the stack table describes this repository', () => {
  test('there is a table, with rows, and it is not trivially satisfied', () => {
    expect(rows.length).toBeGreaterThan(15);
    expect(
      rows.filter((row) => row.names.length > 0 && !row.status.startsWith('not yet')).length,
    ).toBeGreaterThan(5);
    // The measurement could produce the other answer: something really is installed.
    expect(packages.size).toBeGreaterThan(10);
    expect(running.size).toBeGreaterThan(1);
  });

  // Every branch can refuse. These used to be proven by whatever rows the table happened to
  // hold; when the last `not yet` row was installed (D-101), that proof went with it.
  test.each([
    ['a not-yet row whose package is installed', 'not yet · `zustand`'],
    ['a not-yet row that names nothing', 'not yet'],
    ['an undecided row with nothing watching it', 'undecided'],
    ['a row naming a package nothing installs', '`a-package-nobody-installs`'],
  ])('refuses %s', (_, status) => {
    const row = {
      layer: 'probe',
      status,
      names: [...status.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''),
    };
    expect(problemsOf(row).length).toBeGreaterThan(0);
  });

  test.each([
    ['a not-yet row whose package is absent', 'not yet · `a-package-nobody-installs`'],
    ['an undecided row with an issue', 'undecided · #123'],
    ['a row naming an installed package', '`zustand`'],
  ])('accepts %s', (_, status) => {
    const row = {
      layer: 'probe',
      status,
      names: [...status.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? ''),
    };
    expect(problemsOf(row)).toEqual([]);
  });

  for (const row of rows) {
    test(`${row.layer}: "${row.status}" is true of this repository`, () => {
      expect(problemsOf(row)).toEqual([]);
    });
  }
});
