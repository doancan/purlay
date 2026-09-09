// Enforcement, not advice. Every rule here corresponds to a rule the documents
// state in prose; a rule the build does not check is not a rule. (D-47)
import { includeIgnoreFile } from '@eslint/compat';
import { defineConfig, globalIgnores } from 'eslint/config';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // `.gitignore` is the single source for "build output and things not in the
  // repository". Repeating that list here is how one copy silently falls behind
  // the other — which is exactly what happened the first time CI ran this.
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),

  // Ignored for lint but tracked in git, so they cannot come from `.gitignore`.
  globalIgnores(['**/*.d.ts', 'packages/db/src/schema.ts']),

  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // `any` is prohibited by CONTRIBUTING.md §1.3. These make it fail the build.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',

      // The likeliest defect in this architecture is a transaction whose await
      // was forgotten. These two rules are the reason the lint is type-aware.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'always'],

      // Every function has an explicit return type. (CONTRIBUTING.md §1.3)
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],

      // A new union member must break every switch that ignores it.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // Silencing the compiler requires saying why, and expires when the error does.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        { 'ts-ignore': true, 'ts-nocheck': true, 'ts-expect-error': 'allow-with-description' },
      ],

      'no-console': 'error', // logging goes through the structured logger (ARCHITECTURE.md §10)
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message:
            'Take the clock as a dependency instead of reading it directly, so time can be controlled in a test.',
        },
      ],
    },
  },

  // ── Layering: ingress → modules → platform. (ARCHITECTURE.md §4) ────────────
  {
    files: ['apps/api/src/modules/**/*.ts', 'apps/api/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/ingress/**', '**/realtime/**', 'elysia', 'elysia/*'],
              message:
                'A module never imports from ingress, and HTTP or WebSocket types never cross this line. (ARCHITECTURE.md §3, §4)',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/api/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/modules/**', '**/ingress/**', '**/realtime/**'],
              message: 'platform is the bottom layer; it imports from nothing above it.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@purlay/db', '**/apps/api/**'],
              message:
                'apps/web imports only from packages/*. The database never reaches the browser. (ARCHITECTURE.md §4)',
            },
          ],
        },
      ],
      // Bun's types are available repository-wide because Bun is the test runner
      // everywhere. Its runtime is not available in a browser, so reaching for it
      // here compiles and then fails at the worst possible moment.
      'no-restricted-globals': [
        'error',
        { name: 'Bun', message: 'apps/web runs in a browser. Bun APIs do not exist there.' },
      ],
    },
  },

  // This file configures the linter; it is not product code and has no tsconfig
  // project of its own. Format and syntax still apply; type-aware rules do not.
  {
    files: ['eslint.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Tests may reach further, but they may not weaken the type rules.
  {
    files: ['**/*.test.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
]);
