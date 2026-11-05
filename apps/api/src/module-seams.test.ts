/**
 * The doors name a module only where its routes are (D-250, `MODULES.md` §8): `cli/`, `ingress/` and `realtime/` reach a module's work
 * through the composition (`composition.ts`, whose `jobWork` is what `bun run job` runs) and name none of its files, but the
 * one file that registers the modules' routes, `ingress/http/app.ts`, and the route handlers a module keeps in `ingress/`
 * (`MODULES.md` §9 item 4). `eslint.config.mjs` keeps the core (`modules/`, `platform/`) from importing a feature at all; this
 * is the same line for the doors, which the lint cannot draw because chat's own handlers are among them: a file may import a
 * feature only if it is listed here for that feature, and the lists only shrink.
 *
 * What is looked for is an import of a path through `features/<id>`, static, dynamic or re-exported; comments are stripped
 * first. Tests are not held to this: they build a room in a module and read its rows.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const SOURCE_ROOT = import.meta.dir;
const FEATURES = join(SOURCE_ROOT, 'features');

/** The one file of the doors that registers every module's routes: the composition root's other half. */
const COMPOSITION_ROOTS: readonly string[] = [join('ingress', 'http', 'app.ts')];

/** The route handlers of chat, and the doors that still read it, by feature: `ingress/http/<file>.ts` and no other file. */
const CHAT_HANDLERS = [
  'bookmarks',
  'channels',
  'feeds',
  'github-app',
  'github-issues',
  'hidden',
  'incidents',
  'incoming-webhooks',
  'integrations',
  'knowledge',
  'messages',
  'missed-mail',
  'notifications',
  'pins',
  'presence',
  'reactions',
  'reminders',
  'saved',
  'scheduled',
  'star',
  'versions',
  'webhooks',
].map((name) => join('ingress', 'http', `${name}.ts`));

/**
 * What a door may import of a feature, with why. **Only shrinks**: an entry that no longer imports its feature fails the
 * test, and a new file that imports one is refused with it. Not a way to add a module's file to the core's doors: a module
 * reaches the core through its manifest and the composition.
 */
const ALLOWED: Readonly<
  Record<string, { readonly features: readonly string[]; readonly why: string }>
> = {
  ...Object.fromEntries(
    CHAT_HANDLERS.map((file) => [
      file,
      {
        features: ['chat'],
        why: 'a route handler of chat, kept in ingress (MODULES.md §9 item 4)',
      },
    ]),
  ),
  [join('ingress', 'http', 'issues.ts')]: {
    features: ['issues'],
    why: 'a route handler of issues, kept in ingress (MODULES.md §9 item 4)',
  },
  [join('ingress', 'http', 'workspaces.ts')]: {
    features: ['chat'],
    why: 'the workspace routes still read chat’s GitHub client and unfurl check',
  },
  [join('ingress', 'http', 'releases.ts')]: {
    features: ['chat'],
    why: 'the release route takes the type of chat’s release check',
  },
  [join('realtime', 'router.ts')]: {
    features: ['chat'],
    why: 'the frame router still runs chat’s three operations itself (subscribe and replay, message.send, typing) and the manifest has no field for a module’s frame handler yet; `closedFrame` already answers them as an unknown operation where chat is off',
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

/** The folders whose files are the doors: where a request, a command or a frame arrives and is routed. */
const DOORS = ['cli', 'ingress', 'realtime'] as const;

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The ids of the features a source imports a path through: `from '…/features/chat/…'`, `import('…')`, `export … from`. */
const featuresImportedBy = (source: string): string[] => {
  const code = withoutComments(source);
  const ids = [
    ...code.matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*\bfeatures\/([a-z0-9-]+)(?:\/[^'"]*)?['"]/g,
    ),
  ].map((found) => found[1] ?? '');
  return [...new Set(ids)].sort();
};

const doorSources = (): string[] =>
  DOORS.flatMap((directory) =>
    readdirSync(join(SOURCE_ROOT, directory), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(directory, file)),
  ).sort();

const featuresOf = (file: string): string[] =>
  featuresImportedBy(readFileSync(join(SOURCE_ROOT, file), 'utf8'));

describe('the doors name no module’s files outside its routes and the composition root', () => {
  test('the features are the folders of features/, and the files the doors’', () => {
    expect(doorSources()).toContain(join('realtime', 'router.ts'));
    expect(existsSync(FEATURES)).toBe(true);
    expect(readdirSync(FEATURES)).toContain('chat');
    expect(doorSources()).toContain(join('cli', 'jobs.ts'));
    expect(doorSources()).toContain(join('ingress', 'http', 'app.ts'));
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

  test('the command that runs the scheduled jobs names no module’s file', () => {
    expect(featuresOf(join('cli', 'jobs.ts'))).toEqual([]);
  });
});
