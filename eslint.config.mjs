// Enforcement, not advice. Every rule here corresponds to a rule the documents
// state in prose; a rule the build does not check is not a rule. (D-47)
import { includeIgnoreFile } from '@eslint/compat';
import { defineConfig, globalIgnores } from 'eslint/config';
import { fileURLToPath } from 'node:url';
import tseslint from 'typescript-eslint';

// The layering rule two configurations below both need. ESLint replaces a rule
// wholesale rather than merging it, so the block for `modules/` has to restate
// everything the block for `modules/ + platform/` says — which is a second copy,
// and a second copy drifts. Named once instead. (CONTRIBUTING.md §6.1)
const NO_TRANSPORT_TYPES = {
  group: ['**/ingress/**', '**/realtime/**', 'elysia', 'elysia/*'],
  message:
    'A module never imports from ingress, and HTTP or WebSocket types never cross this line. (ARCHITECTURE.md §3, §4)',
};

// The two doors are peers: `ingress` composes `realtime`, never the other way,
// so there is no cycle between them. What both need lives below them, in
// `modules` or `platform`. (ARCHITECTURE.md §4, #245)
const NO_INGRESS = {
  group: ['**/ingress/**'],
  message:
    'realtime does not import from ingress: ingress composes realtime, and a shared need belongs in modules or platform, so the two doors never form a cycle. (ARCHITECTURE.md §4)',
};

/**
 * Reading the time directly makes behaviour that depends on it — expiry, drift
 * correction, retention — untestable without waiting. Both ways of reading it
 * are refused; `platform/clock.ts` and `apps/web/src/system-clock.ts` are the
 * places that do, one per application, and every other caller takes a `Clock` (D-46). `Date.now()` was missing until #202.
 */
const CLOCK_MESSAGE =
  'Take the clock as a dependency instead of reading it directly, so time can be controlled in a test.';
const CLOCK_SELECTORS = [
  { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: CLOCK_MESSAGE,
  },
];

/**
 * A branded context is unforgeable by construction — its brand key is a symbol
 * its own module does not export — but no type system stops a deliberate
 * assertion. This does, everywhere, with no exemption: the guard that mints one
 * never needs a cast, so there is nowhere for a legitimate case to live. Named by
 * the `Context` suffix, so every context — `WorkspaceContext`, `ChannelContext`
 * and any later one — is covered without being listed. (D-21, D-54)
 */
const CONTEXT_MESSAGE =
  'A context is minted by its guard, never asserted. Casting one bypasses the membership check it exists to prove. (D-21, D-54)';
const CONTEXT_SELECTORS = [
  {
    selector: 'TSAsExpression > TSTypeReference > Identifier[name=/Context$/]',
    message: CONTEXT_MESSAGE,
  },
  {
    selector: 'TSTypeAssertion > TSTypeReference > Identifier[name=/Context$/]',
    message: CONTEXT_MESSAGE,
  },
];

/**
 * The escape hatches, made to cost something (CONTRIBUTING.md §1.13, D-48, #136).
 *
 * Local rules rather than a plugin: the rule this repository states — every
 * exception names its rule, explains itself and links an issue — includes the
 * link, which no published plugin checks, and three short rules are less to
 * keep current than a dependency (CONTRIBUTING.md §1.12).
 */
const ISSUE_LINK = /#\d+/;
const commentText = (comment) => comment.value.trim();

const purlay = {
  rules: {
    'accountable-disable': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const match = /^eslint-disable(-next-line|-line)?(?:\s+([\s\S]*))?$/.exec(
                commentText(comment),
              );
              if (match === null) continue;
              const [, scope, rest = ''] = match;
              const [rules = '', description = ''] = rest.split(/\s+--\s+/);
              const problem =
                scope === undefined
                  ? 'A disable for a whole file or block hides every later violation in it. Disable one line, for one rule.'
                  : rules.trim() === ''
                    ? 'A disable names the rule it disables; a blanket one silences rules nobody chose to.'
                    : !ISSUE_LINK.test(description)
                      ? 'A disable explains itself after " -- " and links the issue that will remove it, so it can be counted (CONTRIBUTING.md §1.13).'
                      : undefined;
              if (problem !== undefined) context.report({ loc: comment.loc, message: problem });
            }
          },
        };
      },
    },
    'owned-debt': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const text = commentText(comment);
              for (const marker of text.matchAll(/\b(TODO|FIXME|XXX|HACK)\b(\(#\d+\))?/g)) {
                if (marker[2] === undefined) {
                  context.report({
                    loc: comment.loc,
                    message: `${marker[1]} without an issue is debt nobody owns. Write it as ${marker[1]}(#123) (CONTRIBUTING.md §1.13).`,
                  });
                }
              }
            }
          },
        };
      },
    },
    'no-test-code-import': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const TEST_ONLY = /(^|\/)testing(\/|$)|\.testing(\.ts)?$/;
        const check = (node) => {
          const source = node.source;
          if (source !== null && source !== undefined && typeof source.value === 'string') {
            if (TEST_ONLY.test(source.value)) {
              context.report({
                node: source,
                message:
                  'Production code does not import test-only code (a `testing/` directory or a `*.testing.ts` file). Move what it needs out of testing/, or the code in. (D-47)',
              });
            }
          }
        };
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    },
    'owned-expected-error': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const text = commentText(comment);
              if (text.startsWith('@ts-expect-error') && !ISSUE_LINK.test(text)) {
                context.report({
                  loc: comment.loc,
                  message:
                    'An expected type error in source is an exception like any other: link the issue that will remove it.',
                });
              }
            }
          },
        };
      },
    },
  },
};

export default defineConfig([
  // `.gitignore` is the single source for "build output and things not in the
  // repository". Repeating that list here is how one copy silently falls behind
  // the other — which is exactly what happened the first time CI ran this.
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),

  // Ignored for lint but tracked in git, so they cannot come from `.gitignore`.
  globalIgnores(['**/*.d.ts', 'packages/db/src/schema.ts']),

  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  // A disable that no longer suppresses anything is an error, so the debt
  // removes itself the day the code it excused is fixed (D-48).
  { linterOptions: { reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error' } },

  {
    plugins: { purlay },
    rules: {
      'purlay/accountable-disable': 'error',
      'purlay/owned-debt': 'error',
      'purlay/owned-expected-error': 'error',
    },
  },

  // A test's `@ts-expect-error` is an assertion — *this must not compile* — not
  // an exception. The compiler already fails it if the error ever stops, and
  // `ban-ts-comment` still requires it to say what it asserts. A place, not a
  // waiver (CONTRIBUTING.md §6.5).
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: { 'purlay/owned-expected-error': 'off' },
  },

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
      'no-restricted-syntax': ['error', ...CLOCK_SELECTORS, ...CONTEXT_SELECTORS],
    },
  },

  // ── Layering: ingress → modules → platform. (ARCHITECTURE.md §4) ────────────
  {
    files: ['apps/api/src/modules/**/*.ts', 'apps/api/src/platform/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [NO_TRANSPORT_TYPES],
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
            // A relative path climbs out of apps/web without ever spelling
            // `apps/api`, so the pattern above let it through — measured (#130).
            {
              regex: String.raw`^(\.\./)+(apps/)?api(/|$)`,
              message:
                'apps/web imports only from packages/*, by name — never by climbing into apps/api. (ARCHITECTURE.md §4)',
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
  // project of its own. Format and syntax still apply; type-aware rules do not,
  // and neither does a rule asking for return-type annotations in a JavaScript
  // file, which has no syntax to write one in.
  {
    files: ['eslint.config.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    rules: { '@typescript-eslint/explicit-function-return-type': 'off' },
  },

  // A service takes its executor as an argument — a `Kysely` or a `Transaction`,
  // indistinguishable to the caller. One that reaches for a handle of its own
  // cannot be run inside a rolled-back transaction, which is how every
  // integration test isolates itself. (D-46)
  {
    files: ['apps/api/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [NO_TRANSPORT_TYPES],
          paths: [
            {
              name: '@purlay/db',
              importNames: ['createDatabase'],
              message:
                'Take the executor as an argument instead. A service that opens its own connection cannot be tested inside a transaction. (D-46)',
            },
          ],
        },
      ],
    },
  },

  // The door that composes the other: realtime imports nothing from ingress. Its
  // tests may — they stand up a whole application to drive a real socket — and so
  // may `testing/`, which exists to be used by tests.
  {
    files: ['apps/api/src/realtime/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [NO_INGRESS] }] },
  },
  // Test-only code is for tests. Production code importing it would ship doubles
  // that throw on use, and would put real logic where the coverage report does not
  // look (`bunfig.toml` leaves `testing/` out). A rule of its own rather than a
  // pattern in `no-restricted-imports`, which each layering block above replaces
  // wholesale. (D-47, #245)
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'apps/api/src/testing/**', '**/*.testing.ts'],
    rules: { 'purlay/no-test-code-import': 'error' },
  },

  // Command-line entry points. Their output *is* their interface, so the ban on
  // `console` — which exists because application logging goes through the
  // structured logger (ARCHITECTURE.md §10) — does not apply. D-30 puts every
  // background job here, so this is a place rather than an exception.
  {
    files: ['**/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // The global `screen` binds to `document.body` when `@testing-library/dom` is
  // evaluated, which happens before a component test's DOM registration can run.
  // It therefore throws a confusing error rather than failing to import. The
  // queries `render` returns work, are scoped to what was rendered, and are the
  // better habit. See `apps/web/src/testing/dom.ts` for the measurement.
  {
    files: ['apps/web/**/*.test.tsx', 'apps/web/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@testing-library/react',
              importNames: ['screen'],
              message:
                'Use the queries `render` returns. The global `screen` binds before the test DOM exists and throws. (apps/web/src/testing/dom.ts)',
            },
          ],
        },
      ],
    },
  },

  // The clock itself, and code that measures real elapsed time — a test's
  // deadline, a script's timeout — read the time. Nothing else does. The context
  // selectors stay: no file may forge a context.
  {
    files: [
      'apps/api/src/platform/clock.ts',
      'apps/web/src/system-clock.ts',
      '**/*.test.ts',
      '**/*.test.tsx',
      'scripts/**/*.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...CONTEXT_SELECTORS] },
  },

  // Tests may reach further, but they may not weaken the type rules.
  {
    files: ['**/*.test.ts', 'scripts/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
]);
