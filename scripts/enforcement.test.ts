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

  for (const command of ciCommands) {
    test(`\`${command}\` is part of \`bun run verify\``, () => {
      const script = command.replace(/^bun run /, '');
      const reachable =
        verify.includes(command) ||
        verify.includes(`bun run ${script}`) ||
        Object.values(pkg.scripts).some((s) => s.includes(command));
      expect(reachable).toBe(true);
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

  test('no compiled test file exists under a scanned directory', () => {
    const found = Bun.spawnSync([
      'bash',
      '-lc',
      "find apps packages scripts -name '*.test.js' -not -path '*/node_modules/*' | head -1",
    ]);
    expect(found.stdout.toString().trim()).toBe('');
  });
});
