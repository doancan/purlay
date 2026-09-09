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
        "-o -name '*.d.ts.map' \\) -not -path '*/node_modules/*'",
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
