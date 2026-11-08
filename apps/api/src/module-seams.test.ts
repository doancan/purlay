/**
 * The doors name a module only where its routes are (D-250, `MODULES.md` §8): `cli/`, `ingress/`, `realtime/` and the process entry `index.ts` reach a module's work
 * through the composition (`composition.ts`, whose `jobWork` is what `bun run job` runs) and name none of its files, but the
 * one file that composes the modules' routes, `ingress/http/app.ts`. `eslint.config.mjs` keeps the core (`modules/`, `platform/`) from importing a feature at all; this
 * is the same line for the doors, which the lint cannot draw because chat's own handlers are among them: a file may import a
 * feature only if it is listed here for that feature, and the lists only shrink.
 *
 * What is looked for is an import of a path through `features/<id>`, static, dynamic or re-exported; comments are stripped
 * first. Tests are not held to this: they build a room in a module and read its rows.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { featuresImportedBy } from './testing/module-sources';

const SOURCE_ROOT = import.meta.dir;
const FEATURES = join(SOURCE_ROOT, 'features');

/** The one file of the doors that registers every module's routes: the composition root's other half. */
const COMPOSITION_ROOTS: readonly string[] = [join('ingress', 'http', 'app.ts')];

/**
 * What a door may import of a feature, with why. **Only shrinks**: an entry that no longer imports its feature fails the
 * test, and a new file that imports one is refused with it. Not a way to add a module's file to the core's doors: a module
 * reaches the core through its manifest and the composition.
 */
const ALLOWED: Readonly<
  Record<string, { readonly features: readonly string[]; readonly why: string }>
> = {
  [join('ingress', 'http', 'releases.ts')]: {
    features: ['chat'],
    why: 'the release route takes the type of chat’s release check',
  },
  [join('ingress', 'ws', 'socket.ts')]: {
    features: ['chat'],
    why: 'the socket announces presence through chat’s presence service',
  },
  [join('cli', 'erase-content.ts')]: {
    features: ['chat'],
    why: '`bun run erase:content` empties chat’s messages; a command of a module has no manifest field yet',
  },
};

/**
 * The sizes `ALLOWED` may have: all of it, and the part in `cli/`, where a command of a module has no manifest field to
 * go through. Each list only shrinks, but "an entry still imports its feature" cannot see one being added; these can. A
 * door joins a list only with its cap raised in the same change, a line a reviewer reads and has to accept.
 */
const MAX_ALLOWED = 3;
const MAX_ALLOWED_IN_CLI = 1;

/** The folders whose files are the doors: where a request, a command or a frame arrives and is routed. */
const DOORS = ['cli', 'ingress', 'realtime'] as const;

/**
 * The process entry (`index.ts`) is a door too: it starts what the composition says the modules run, the workers among
 * them (`MODULES.md` §9), and names no module's work itself. It is read as the doors are, with nothing listed for it.
 */
const PROCESS_ENTRY = 'index.ts';

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const doorSources = (): string[] =>
  [
    ...DOORS.flatMap((directory) =>
      readdirSync(join(SOURCE_ROOT, directory), { recursive: true, encoding: 'utf8' })
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .map((file) => join(directory, file)),
    ),
    PROCESS_ENTRY,
  ].sort();

const featuresOf = (file: string): string[] =>
  featuresImportedBy(readFileSync(join(SOURCE_ROOT, file), 'utf8'));

describe('the doors name no module’s files outside its routes and the composition root', () => {
  test('the features are the folders of features/, and the files the doors’', () => {
    expect(doorSources()).toContain(join('realtime', 'router.ts'));
    expect(existsSync(FEATURES)).toBe(true);
    expect(readdirSync(FEATURES)).toContain('chat');
    expect(doorSources()).toContain(join('cli', 'jobs.ts'));
    expect(doorSources()).toContain(join('ingress', 'http', 'app.ts'));
    expect(doorSources()).toContain(PROCESS_ENTRY);
    for (const root of COMPOSITION_ROOTS) expect(doorSources()).toContain(root);
  });

  test('it sees an import in each way one is written, and nothing in a comment or a path', () => {
    for (const named of [
      "import { x } from '../features/chat/sweeps';",
      "import type { T } from '../../features/issues/budget';",
      "export { x } from '../features/chat/jobs';",
      "const later = await import('../features/chat/jobs');",
      "import '../features/chat/jobs';",
    ]) {
      expect(featuresImportedBy(named)).toHaveLength(1);
    }
    for (const unnamed of [
      "// import { x } from '../features/chat/sweeps';",
      "/* import { x } from '../features/chat/sweeps'; */",
      "const path = '/api/features/chat';",
      "import { x } from '../modules/features-list';",
    ]) {
      expect(featuresImportedBy(unnamed)).toEqual([]);
    }
  });

  test('no door imports a feature it is not listed for', () => {
    const unlisted = doorSources()
      .filter((file) => !COMPOSITION_ROOTS.includes(file))
      .flatMap((file) =>
        featuresOf(file)
          .filter((id) => !(ALLOWED[file]?.features ?? []).includes(id))
          .map((id) => `${file} imports features/${id}`),
      );
    expect(unlisted).toEqual([]);
  });

  test('an entry of the list is a door that still imports the feature it names', () => {
    const stale = Object.entries(ALLOWED).flatMap(([file, { features }]) =>
      !existsSync(join(SOURCE_ROOT, file))
        ? [`${file} is not a file`]
        : features
            .filter((id) => !featuresOf(file).includes(id))
            .map((id) => `${file} no longer imports features/${id}`),
    );
    expect(stale).toEqual([]);
  });

  test('the lists are no longer than their caps, so an entry is added only with the cap raised', () => {
    const files = Object.keys(ALLOWED);
    expect(files.length).toBeLessThanOrEqual(MAX_ALLOWED);
    expect(files.filter((file) => file.startsWith(`cli${sep}`)).length).toBeLessThanOrEqual(
      MAX_ALLOWED_IN_CLI,
    );
  });

  test('a module’s route handler is not a door: chat’s missed-mail routes are in its folder, and no ingress file is listed for it', () => {
    expect(existsSync(join(SOURCE_ROOT, 'ingress', 'http', 'missed-mail.ts'))).toBe(false);
    expect(existsSync(join(FEATURES, 'chat', 'http', 'missed-mail.ts'))).toBe(true);
    expect(Object.keys(ALLOWED).sort()).toEqual(
      [
        join('cli', 'erase-content.ts'),
        join('ingress', 'http', 'releases.ts'),
        join('ingress', 'ws', 'socket.ts'),
      ].sort(),
    );
  });

  test('the command that runs the scheduled jobs names no module’s file', () => {
    expect(featuresOf(join('cli', 'jobs.ts'))).toEqual([]);
  });

  test('the process entry names no module’s file: what a module does on a timer is its workers, through the composition', () => {
    expect(featuresOf(PROCESS_ENTRY)).toEqual([]);
    expect(Object.keys(ALLOWED)).not.toContain(PROCESS_ENTRY);
  });
});

/**
 * A module's handlers cannot take the pool without its module's share (`MODULES.md` §7, D-266). The share is a lease on
 * every connection of the one database `createApp` hands the handlers, so what would get round it is another handle:
 * the raw one the application was given, used a second time, or a pool a module opened for itself. Neither exists today,
 * and this holds both to that. The rest, that a request of a module is noted as its own and held, is
 * `features/issues/http/budget.integration.test.ts` and `ingress/http/chat-budget.integration.test.ts`, and the mutation
 * `application-database-not-leased`.
 */
const APP_FILE = join('ingress', 'http', 'app.ts');
const POOL_OPENERS = /\b(?:createDatabase|executorOnPool|leasableStandIn)\s*\(|from\s*['"]pg['"]/;

describe('a module’s handlers reach the database only through the one the application leases', () => {
  test('the application uses the database it was given once, to lease it', () => {
    const uses = withoutComments(readFileSync(join(SOURCE_ROOT, APP_FILE), 'utf8')).match(
      /\bgiven\.database\b/g,
    );
    expect(uses).toHaveLength(1);
  });

  test('no feature and no door but the composition root opens a pool of its own', () => {
    const files = ['features', 'ingress']
      .flatMap((directory) =>
        readdirSync(join(SOURCE_ROOT, directory), { recursive: true, encoding: 'utf8' })
          .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
          .map((file) => join(directory, file)),
      )
      .filter((file) =>
        POOL_OPENERS.test(withoutComments(readFileSync(join(SOURCE_ROOT, file), 'utf8'))),
      );
    expect(files).toEqual([]);
  });

  test('it sees a second use of the raw handle, and nothing in a comment', () => {
    const count = (source: string): number =>
      withoutComments(source).match(/\bgiven\.database\b/g)?.length ?? 0;
    expect(count('const again = given.database;')).toBe(1);
    expect(count('// given.database\n/* given.database */')).toBe(0);
  });
});

/**
 * What a module does on a timer is held to its share and its deadline (`MODULES.md` §7, §9): the process entry starts the
 * workers the composition names, over the one set of shares its application takes, and stops them with the process. What
 * the entry hands the workers is the leased database; the raw handle would be a loop that took the pool as it pleased.
 */
describe('the process entry starts the modules’ workers over the shares of the pool', () => {
  const entry = withoutComments(readFileSync(join(SOURCE_ROOT, PROCESS_ENTRY), 'utf8'));

  test('it starts the workers the composition says run, on the leased database and no other', () => {
    expect(entry).toMatch(/startWorkers\(\s*modules\.workers,/);
    expect(entry).toMatch(
      /startWorkers\([^)]*database:\s*leasingExecutor\(database, moduleShares\)/s,
    );
  });

  test('the application takes those shares too, so a request and a worker of a module hold the same slots', () => {
    expect(entry).toMatch(/createApp\(\{[^}]*\bmoduleShares,/s);
  });

  test('workers cannot start after shutdown began while boot was still waiting', () => {
    expect(entry).toMatch(/workerLifecycle\.stopped = true;[\s\S]*await activeWorkers\?\.stop\(\)/);
    expect(entry).toMatch(/if \(!workerLifecycle\.stopped\) \{\s*activeWorkers = startWorkers\(/);
  });

  test('it stops them when the process is crashing and when it is shut down', () => {
    expect(entry.match(/\bworkers\.stop\(\)/g)).toHaveLength(2);
  });
});
