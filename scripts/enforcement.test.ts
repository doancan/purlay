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

  for (const command of ciCommands) {
    const script = command.replace(/^bun run /, '');

    test(`\`${command}\` is a command a developer can run`, () => {
      expect(Object.keys(pkg.scripts)).toContain(script);
    });

    test(`\`${command}\` is either in \`verify\` or documented`, () => {
      const inVerify = verify.includes(`bun run ${script}`);
      const documented = contributing.includes(`bun run ${script}`);
      expect(inVerify || documented).toBe(true);
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
