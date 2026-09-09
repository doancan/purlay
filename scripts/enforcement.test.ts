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
