/**
 * The enforcement layer guarding itself.
 *
 * Every flag and rule below corresponds to a sentence in the documents. The
 * failure this prevents is not a bug — it is somebody quietly turning a rule off
 * because it was inconvenient once, which is how a well-specified project becomes
 * an ordinary one. (D-47)
 */
import { describe, expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

const base = JSON.parse(readFileSync('packages/config/tsconfig.base.json', 'utf8')) as {
  compilerOptions: Record<string, unknown>;
};

describe('compiler strictness (CONTRIBUTING.md §1.3, D-47)', () => {
  const required = [
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noPropertyAccessFromIndexSignature',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'useUnknownInCatchVariables',
    'verbatimModuleSyntax',
  ] as const;

  for (const flag of required) {
    test(`${flag} is on`, () => {
      expect(base.compilerOptions[flag]).toBe(true);
    });
  }

  test('allowJs stays off — this codebase is TypeScript', () => {
    expect(base.compilerOptions['allowJs']).toBe(false);
  });
});

// Resolved through ESLint itself, so restructuring the config file cannot silently
// drop a rule while the file still mentions it. Top-level await: this is an ESM module.
const apiConfig = (await new ESLint().calculateConfigForFile('apps/api/src/index.ts')) as {
  rules: Record<string, unknown[] | undefined>;
};

describe('lint rules in effect for API source (D-47)', () => {
  const required = [
    '@typescript-eslint/no-explicit-any',
    '@typescript-eslint/no-unsafe-assignment',
    '@typescript-eslint/no-unsafe-call',
    '@typescript-eslint/no-unsafe-member-access',
    '@typescript-eslint/no-unsafe-return',
    '@typescript-eslint/no-unsafe-argument',
    '@typescript-eslint/no-floating-promises',
    '@typescript-eslint/no-misused-promises',
    '@typescript-eslint/await-thenable',
    '@typescript-eslint/explicit-function-return-type',
    '@typescript-eslint/switch-exhaustiveness-check',
    '@typescript-eslint/ban-ts-comment',
    // Carries the ban on reading the clock directly and on asserting a branded
    // context into existence. Which shapes it rejects is proved separately, by
    // `verify-enforcement.ts` writing one. (D-54)
    'no-restricted-syntax',
  ] as const;

  const rules = apiConfig.rules;

  for (const rule of required) {
    test(`${rule} is an error`, () => {
      const entry = rules[rule];
      expect(entry).toBeDefined();
      expect(entry?.[0]).toBe(2);
    });
  }
});

describe('the documents are not reformatted by tooling', () => {
  test('prettier ignores markdown', () => {
    expect(readFileSync('.prettierignore', 'utf8')).toContain('*.md');
  });
});

/**
 * Local green must mean CI green.
 *
 * This has already failed twice: once because the linter's ignore list did not
 * match the one CI produced, and once because `verify` omitted a step CI ran.
 * Both were invisible locally. Comparing the two lists is cheaper than
 * rediscovering the difference from a red pipeline.
 */
describe('the local verify runs everything CI runs', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  const verify = pkg.scripts['verify'] ?? '';

  // Steps that set the machine up rather than check the code.
  const setup = /bun install|actions\/|uses:/;
  const ciCommands = [...workflow.matchAll(/^\s+run:\s*(.+)$/gm)]
    .map((m) => (m[1] ?? '').trim())
    .filter((c) => !setup.test(c));

  test('CI actually runs something', () => {
    expect(ciCommands.length).toBeGreaterThan(3);
  });

  // Some checks need infrastructure — a database, in particular — and putting
  // those in `verify` would make the fast loop depend on Docker being up. So the
  // rule is not "everything is in verify"; it is "everything CI runs, a developer
  // can run, and knows about". Anything outside `verify` has to be documented.
  const contributing = readFileSync('CONTRIBUTING.md', 'utf8');

  /** `bun run config:example -- --check` names the script `config:example`. */
  const scriptName = (command: string): string =>
    (command.replace(/^bun run /, '').split(' ')[0] ?? '').trim();

  for (const command of ciCommands) {
    const script = scriptName(command);

    test(`\`${command}\` is a command a developer can run`, () => {
      expect(Object.keys(pkg.scripts)).toContain(script);
    });

    test(`\`${command}\` is either in \`verify\` or documented`, () => {
      const inVerify = verify.includes(`bun run ${script}`);
      const documented = contributing.includes(`bun run ${script}`);
      expect(inVerify || documented).toBe(true);
    });
  }

  /**
   * And the other direction, which was missing.
   *
   * Only CI can block a merge. A step that runs in `verify` and nowhere else is a
   * check a developer can pass locally and a pull request can ignore — which is
   * how `config:example -- --check` sat outside the pipeline unnoticed. Comparing
   * one direction told us every CI step was runnable and nothing about whether
   * every runnable step was in CI (`CONTRIBUTING.md` §6.4).
   */
  const ciScripts = new Set(ciCommands.map(scriptName));
  const verifySteps = [...verify.matchAll(/bun run ([\w:-]+)/g)].map((m) => m[1] ?? '');

  test('verify is made of steps, so this comparison is not vacuous', () => {
    expect(verifySteps.length).toBeGreaterThan(5);
  });

  for (const step of verifySteps) {
    test(`\`${step}\` runs in CI too, so it can actually block a merge`, () => {
      expect([...ciScripts]).toContain(step);
    });
  }
});

/**
 * Build output never lands in a directory a check scans.
 *
 * `bun test` found compiled copies of its own test files and ran them twice;
 * before that, the linter tried to parse its own output. Both were the same
 * mistake — emitted artifacts sitting inside the source tree — so the invariant
 * is stated once here rather than remembered per tool.
 */
describe('build output stays outside the source tree', () => {
  const projects = ['packages/types', 'packages/db', 'apps/api', 'apps/web', 'scripts'] as const;

  for (const project of projects) {
    test(`${project} emits into .tsbuild`, () => {
      const config = JSON.parse(readFileSync(`${project}/tsconfig.json`, 'utf8')) as {
        compilerOptions: { outDir?: string };
      };
      expect(config.compilerOptions.outDir).toMatch(/\.tsbuild\//);
    });
  }

  /**
   * Broadened after a cross-project relative import made the compiler compute a
   * common root and emit beside the sources. The earlier version looked only for
   * compiled *tests*, so it watched the symptom that had already happened rather
   * than the thing that causes it.
   */
  test('no compiled output of any kind sits beside a source file', () => {
    const found = Bun.spawnSync([
      'bash',
      '-lc',
      "find apps packages scripts \\( -name '*.js' -o -name '*.js.map' -o -name '*.d.ts' " +
        "-o -name '*.d.ts.map' \\) -not -path '*/node_modules/*' -not -path '*/dist/*'",
    ]);
    expect(found.stdout.toString().trim()).toBe('');
  });
});

/**
 * Integration tests are selected by name, and a name is a fragile thing to
 * depend on. The dangerous direction is silence: a file that needs a database
 * but whose describe does not start with the marker simply never runs, and the
 * suite stays green while proving nothing.
 *
 * So the convention is a rule with a check, rather than a convention.
 */
// Deliberately not named with the marker: this check needs no database, and a
// name starting with it would pull it into the integration run — a filter
// matching something it was not meant to match.
describe('selecting the integration tests reliably', () => {
  const files = Bun.spawnSync([
    'bash',
    '-lc',
    // The same roots `bun test` is given in package.json. A directory the runner
    // scans but this does not is a file that can quietly opt out of the convention.
    "find apps packages scripts -name '*.integration.test.ts' -not -path '*/node_modules/*'",
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  test('there is at least one, so the check is not vacuous', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file} opens with the marker the runner filters on`, () => {
      const source = readFileSync(file, 'utf8');
      const describes = [...source.matchAll(/^describe\(\s*['"`]([^'"`]+)/gm)].map(
        (match) => match[1] ?? '',
      );
      expect(describes.length).toBeGreaterThan(0);
      for (const name of describes) {
        expect(name.startsWith('integration')).toBe(true);
      }
    });
  }

  test('the fast run excludes them, so it needs no infrastructure', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['test']).toContain('*.integration.test.ts');
    expect(pkg.scripts['test:integration']).toContain('^integration');
  });
});

/**
 * Every file the linter reads is a file a compiler reads.
 *
 * `apps/web/tsconfig.json` said `include: ["src/**\/*.ts"]` and carried no `jsx`
 * setting, while `eslint.config.mjs` lints `apps/web/**\/*.tsx`. A component would
 * therefore have been linted and **never typechecked**, and `bun run typecheck`
 * would have reported success over zero of them — a green check measuring an
 * empty set, which is the failure this repository guards against everywhere else
 * (`CONTRIBUTING.md` §6.4).
 *
 * The compiler answers for itself: `tsc --showConfig` expands `include` into the
 * exact file list a project compiles, so this compares two real sets rather than
 * reimplementing glob semantics and trusting the reimplementation.
 */
describe('the compiler sees every file the linter does', () => {
  /**
   * Derived from the solution config, not listed. A hand-written list is a
   * second copy, and this one fell behind within the hour: a tooling project
   * was added and the check reported a file that nothing compiled.
   */
  const solution = JSON.parse(readFileSync('tsconfig.json', 'utf8')) as {
    references: readonly { path: string }[];
  };
  const PROJECTS = solution.references.map((reference) => reference.path);

  const compiled = new Set<string>();
  for (const project of PROJECTS) {
    const shown = Bun.spawnSync(['bun', 'x', 'tsc', '--showConfig', '-p', project]);
    const config = JSON.parse(shown.stdout.toString()) as { files?: readonly string[] };
    // A reference may name a directory or a config file; `files` are relative
    // to whichever directory that config lives in.
    const base = project.endsWith('.json') ? dirname(project) : project;
    for (const file of config.files ?? []) {
      compiled.add(resolve(base, file));
    }
  }

  const linted = Bun.spawnSync([
    'bash',
    '-lc',
    "find apps packages scripts \\( -name '*.ts' -o -name '*.tsx' \\) " +
      "-not -path '*/node_modules/*' -not -name '*.d.ts'",
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((file) => resolve(file));

  test('there are source files at all, so this is not an empty comparison', () => {
    expect(linted.length).toBeGreaterThan(10);
    expect(compiled.size).toBeGreaterThan(10);
  });

  for (const file of linted) {
    test(`${relative(process.cwd(), file)} is compiled by some project`, () => {
      expect(compiled.has(file)).toBe(true);
    });
  }
});

/**
 * Every dependency is pinned exactly.
 *
 * A caret range is the polite way of saying "I do not know which version this
 * is". The lockfile knows, but a lockfile is a consequence, and a green check
 * from a different resolved tree is the "green in one state is not green"
 * problem one layer down (`CONTRIBUTING.md` §6.3). An exact pin makes an upgrade
 * a visible commit that CI judges, which is what Dependabot already opens.
 *
 * `workspace:*` is not a range — it names the package in this repository, and
 * there is nothing else it could resolve to. (D-56)
 */
describe('dependencies are pinned, not ranged', () => {
  const manifests = Bun.spawnSync([
    'bash',
    '-lc',
    'ls package.json apps/*/package.json packages/*/package.json',
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  test('there are manifests to check', () => {
    expect(manifests.length).toBeGreaterThan(3);
  });

  for (const manifest of manifests) {
    test(`${manifest} names an exact version for everything it installs`, () => {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      const ranged: string[] = [];
      for (const field of ['dependencies', 'devDependencies'] as const) {
        for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
          if (spec.startsWith('workspace:')) continue;
          // An alias carries its own spec after the last `@`; check that part.
          const version = spec.startsWith('npm:') ? (spec.split('@').pop() ?? '') : spec;
          if (!/^\d/.test(version)) ranged.push(`${name}: ${spec}`);
        }
      }
      expect(ranged).toEqual([]);
    });
  }
});

/**
 * A script never reaches the network for a tool the repository pins.
 *
 * `bun x vite` from the repository root silently downloaded **vite@latest** and
 * built with it, because `vite` is installed under `apps/web` and `bun x` found
 * nothing locally. It worked, which is the problem: the build succeeded with an
 * unpinned version and said nothing. That is the same failure D-56 removed from
 * the documents, one layer down — a version nobody chose, used without a trace.
 *
 * So a script may only `bun x` something the manifest it lives in installs.
 */
describe('scripts run the versions this repository pins', () => {
  const manifests = Bun.spawnSync([
    'bash',
    '-lc',
    'ls package.json apps/*/package.json packages/*/package.json',
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  const invocations: (readonly [string, string, string])[] = [];
  for (const manifest of manifests) {
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      for (const match of command.matchAll(/\bbun\s+x\s+([@\w][\w@/.-]*)/g)) {
        const tool = match[1] ?? '';
        if (!installed.has(tool)) invocations.push([manifest, name, tool]);
      }
    }
  }

  test('there are scripts to check', () => {
    expect(manifests.length).toBeGreaterThan(3);
  });

  test('every `bun x` names a tool the same manifest installs', () => {
    expect(invocations.map(([m, s, t]) => `${m} → ${s} → ${t}`)).toEqual([]);
  });
});

/**
 * One command starts everything a developer needs running.
 *
 * Not a style preference: a two-process product whose two processes start
 * differently is one somebody eventually runs half of, then debugs the half that
 * is missing. `dev` delegates to each workspace's own `dev` rather than
 * repeating their commands, so there is one definition of how each starts.
 */
describe('development starts with one command', () => {
  const root = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };

  test('`dev` exists and names both applications', () => {
    const dev = root.scripts['dev'] ?? '';
    expect(dev).toContain('@purlay/api');
    expect(dev).toContain('@purlay/web');
  });

  for (const app of ['apps/api', 'apps/web'] as const) {
    test(`${app} defines the \`dev\` script that delegation resolves to`, () => {
      const pkg = JSON.parse(readFileSync(`${app}/package.json`, 'utf8')) as {
        scripts?: Record<string, string>;
      };
      expect(Object.keys(pkg.scripts ?? {})).toContain('dev');
    });
  }

  /** The single-process shortcuts must not restate what the workspace already says. */
  for (const [shortcut, app] of [
    ['dev:api', 'apps/api'],
    ['dev:web', 'apps/web'],
  ] as const) {
    test(`\`${shortcut}\` delegates rather than repeating the command`, () => {
      expect(root.scripts[shortcut]).toBe(`bun run --cwd ${app} dev`);
    });
  }
});

/**
 * Every path the API owns is proxied in development.
 *
 * One origin is a decision (D-61), and a path left out of the proxy is that
 * decision quietly untrue for that path: `/health` answered with the client's
 * HTML until it was added. The check reads the routes the application registers
 * and requires the proxy to cover each of their first segments.
 */
describe('development serves the one origin it promises', () => {
  const app = readFileSync('apps/api/src/ingress/http/app.ts', 'utf8');
  const vite = readFileSync('apps/web/vite.config.ts', 'utf8');

  const served = [...app.matchAll(/\.(?:get|post|put|patch|delete)\('(\/[^']*)'/g)].map(
    (match) => `/${(match[1] ?? '').split('/')[1] ?? ''}`,
  );
  const proxied = [
    ...(/\[([^\]]*)\]\.map\(\(prefix\)/.exec(vite)?.[1] ?? '').matchAll(/'([^']+)'/g),
  ].map((match) => match[1] ?? '');

  test('the application serves paths, and the proxy lists some', () => {
    expect(served.length).toBeGreaterThan(2);
    expect(proxied.length).toBeGreaterThan(2);
  });

  for (const prefix of [...new Set(served)]) {
    test(`${prefix} reaches the API through the development proxy`, () => {
      expect(proxied).toContain(prefix);
    });
  }
});

/**
 * The message-id window is the one D-33 decided.
 *
 * The unit tests around it compute their offsets from the constant, so they move
 * with it — widening the window from five seconds to sixty passed every one of
 * them. A test that reads the value it is testing cannot catch a change to that
 * value, which is the tautological pass `CONTRIBUTING.md` §6.4 is about.
 *
 * So the code is bound to the decision instead. Changing either without the other
 * fails here.
 */
describe('the message-id skew window matches the decision that set it', () => {
  const decisions = readFileSync('docs/DECISIONS.md', 'utf8');
  const source = readFileSync('packages/types/src/message-id.ts', 'utf8');

  const stated = /within `\[now − (\d+) s, now \+ (\d+) s\]`/.exec(decisions);
  const declared = /behindMs: ([\d_]+), aheadMs: ([\d_]+)/.exec(source);

  test('both places still say it, so this is not comparing nothing to nothing', () => {
    expect(stated).not.toBeNull();
    expect(declared).not.toBeNull();
  });

  test('the code allows exactly what the decision permits, behind and ahead', () => {
    const seconds = (value: string | undefined): number => Number(value?.replace(/_/g, '') ?? '0');
    expect(seconds(declared?.[1]) / 1000).toBe(Number(stated?.[1]));
    expect(seconds(declared?.[2]) / 1000).toBe(Number(stated?.[2]));
  });
});

/**
 * `OFFSET` never appears in a query against `messages`.
 *
 * It is O(n) and it shifts under concurrent inserts, which in a live channel is
 * every page (`SCHEMA.md` §6.3). The prohibition was prose until the code it
 * governs existed; this is one of the architecture fitness tests #130 collects,
 * added with the code rather than after it.
 */
describe('the message feed is keyset, never offset', () => {
  const sources = Bun.spawnSync([
    'bash',
    '-lc',
    "find apps/api/src -name '*.ts' -not -name '*.test.ts' | xargs grep -l 'messages' || true",
  ])
    .stdout.toString()
    .trim()
    .split('\n')
    .filter(Boolean);

  test('there are files that query messages, so this is not an empty sweep', () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  /**
   * Comments are stripped first. The prohibition is *explained* in prose in the
   * file that obeys it, and the first version of this check matched that prose —
   * a check reporting a violation it had read in a comment, which is the same
   * defect as one passing because it matched a comment (`CONTRIBUTING.md` §6.4).
   */
  const code = (file: string): string =>
    readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');

  test('stripping comments leaves code, so the sweep is not looking at nothing', () => {
    expect(sources.every((file) => code(file).includes('export'))).toBe(true);
  });

  for (const file of sources) {
    test(`${file} paginates by cursor`, () => {
      expect(code(file)).not.toMatch(/\.offset\(|\bOFFSET\b/);
    });
  }
});
