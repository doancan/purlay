/**
 * The acceptance test for the enforcement layer.
 *
 * D-47 says a rule that is not mechanically enforced is not a rule. This script
 * is how that claim is checked rather than asserted: for each rule the documents
 * state in prose, it writes a file that violates it and requires the linter to
 * reject it. If a violation ever passes, the rule has quietly stopped existing.
 *
 * Run by CI. A failure here means the guardrails are gone, not that the code is
 * wrong — which is the more expensive failure of the two.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

interface Violation {
  readonly rule: string;
  /**
   * The rule that must be the one to reject it.
   *
   * Without this, the check is "eslint exited non-zero", which any unrelated
   * error satisfies — a demonstration that passes for the wrong reason, and so
   * proves nothing about the rule it names (`CONTRIBUTING.md` §6.4).
   */
  readonly ruleId: string;
  /** Path relative to the repository root — the layering rules are path-scoped. */
  readonly path: string;
  readonly source: string;
  /**
   * A control rather than a violation: the rule must stay **silent** here. It is
   * what shows a rule is not simply refusing everything that looks like its
   * target — a rule that cannot pass the right thing proves as little as one that
   * cannot fail the wrong one.
   */
  readonly allowed?: true;
}

/**
 * What ESLint reports, with no rule id, for a disable that suppressed nothing.
 * Named so a violation can expect it like any rule.
 */
const UNUSED_DISABLE = 'unused-disable-directive';

const VIOLATIONS: readonly Violation[] = [
  {
    rule: 'no-explicit-any (CONTRIBUTING.md §1.3)',
    ruleId: '@typescript-eslint/no-explicit-any',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: 'export const widen = (value: any): unknown => value;\n',
  },
  {
    rule: 'no-floating-promises (D-47)',
    ruleId: '@typescript-eslint/no-floating-promises',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      'const work = async (): Promise<void> => {};\nexport const go = (): void => {\n  work();\n};\n',
  },
  {
    rule: 'explicit-function-return-type (CONTRIBUTING.md §1.3)',
    ruleId: '@typescript-eslint/explicit-function-return-type',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
  },
  {
    rule: 'layering: a module may not import from ingress (ARCHITECTURE.md §4)',
    ruleId: 'no-restricted-imports',
    path: 'apps/api/src/modules/__enforcement__.ts',
    source:
      "import { thing } from '../ingress/http/routes';\n\nexport const use = (): unknown => thing;\n",
  },
  // The two doors are peers, and ingress composes realtime, so the cycle that was
  // there (realtime importing a cookie module out of ingress) cannot return. (#245)
  {
    rule: 'layering: realtime may not import from ingress, so the doors form no cycle (ARCHITECTURE.md §4)',
    ruleId: 'no-restricted-imports',
    path: 'apps/api/src/realtime/__enforcement__.ts',
    source:
      "import { thing } from '../ingress/http/cookies';\n\nexport const use = (): unknown => thing;\n",
  },
  {
    rule: 'layering: ingress composing realtime is the allowed direction',
    ruleId: 'no-restricted-imports',
    path: 'apps/api/src/ingress/http/__enforcement__.ts',
    source:
      "import { thing } from '../../realtime/hub';\n\nexport const use = (): unknown => thing;\n",
    allowed: true,
  },
  {
    rule: 'layering: a realtime test may stand up the application through ingress',
    ruleId: 'no-restricted-imports',
    path: 'apps/api/src/realtime/__enforcement__.test.ts',
    source:
      "import { thing } from '../ingress/http/app';\n\nexport const use = (): unknown => thing;\n",
    allowed: true,
  },
  // Test-only code stays out of what ships. (#245)
  {
    rule: 'production code may not import test-only code: ingress (#245)',
    ruleId: 'purlay/no-test-code-import',
    path: 'apps/api/src/ingress/http/__enforcement__.ts',
    source:
      "import { thing } from '../../testing/doubles';\n\nexport const use = (): unknown => thing;\n",
  },
  {
    rule: 'production code may not import test-only code: a module (#245)',
    ruleId: 'purlay/no-test-code-import',
    path: 'apps/api/src/modules/__enforcement__.ts',
    source:
      "import { thing } from '../testing/users';\n\nexport const use = (): unknown => thing;\n",
  },
  {
    rule: 'production code may not import test-only code: a *.testing.ts file, re-exported (#245)',
    ruleId: 'purlay/no-test-code-import',
    path: 'apps/api/src/realtime/__enforcement__.ts',
    source: "export { thing } from './hub.testing';\n",
  },
  {
    rule: 'production code may not import test-only code: a dynamic import (#245)',
    ruleId: 'purlay/no-test-code-import',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: "export const load = async (): Promise<unknown> => await import('../testing/users');\n",
  },
  {
    rule: 'a test may import test-only code',
    ruleId: 'purlay/no-test-code-import',
    path: 'apps/api/src/modules/__enforcement__.test.ts',
    source:
      "import { thing } from '../testing/users';\n\nexport const use = (): unknown => thing;\n",
    allowed: true,
  },
  {
    rule: 'test-only code may import test-only code',
    ruleId: 'purlay/no-test-code-import',
    path: 'apps/api/src/testing/__enforcement__.ts',
    source: "import { thing } from './doubles';\n\nexport const use = (): unknown => thing;\n",
    allowed: true,
  },
  {
    rule: 'layering: the browser may not import the database (ARCHITECTURE.md §4)',
    ruleId: 'no-restricted-imports',
    path: 'apps/web/src/__enforcement__.ts',
    source: "import { db } from '@purlay/db';\n\nexport const use = (): unknown => db;\n",
  },
  {
    rule: 'layering: the browser may not climb into the API by a relative path (ARCHITECTURE.md §4)',
    ruleId: 'no-restricted-imports',
    path: 'apps/web/src/__enforcement__.ts',
    source:
      "import { systemClock } from '../../api/src/platform/clock';\n\nexport const use = (): unknown => systemClock;\n",
  },
  {
    rule: 'the browser may not reach for Bun APIs (ARCHITECTURE.md §4)',
    ruleId: 'no-restricted-globals',
    path: 'apps/web/src/__enforcement__.ts',
    source: 'export const read = (): unknown => Bun.file("x");\n',
  },
  {
    rule: 'ban-ts-comment: @ts-ignore is prohibited (D-47)',
    ruleId: '@typescript-eslint/ban-ts-comment',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: '// @ts-ignore\nexport const broken: number = "not a number";\n',
  },
  // Reaching for the global `screen` in a component test produces a confusing
  // runtime error rather than a compile failure, so lint has to be what stops it.
  {
    rule: 'the global `screen` is refused in component tests (docs/spikes/web-client.md)',
    ruleId: 'no-restricted-imports',
    path: 'apps/web/src/__enforcement__.test.tsx',
    source:
      "import { screen } from '@testing-library/react';\n\nexport const use = (): unknown => screen;\n",
  },
  // `new Date()` was refused and `Date.now()` was not, so the rule could be met by
  // reading the clock the other way. (#202)
  {
    rule: 'the clock is a dependency: Date.now() outside platform/clock.ts (D-46)',
    ruleId: 'no-restricted-syntax',
    path: 'apps/api/src/modules/__enforcement__.ts',
    source: 'export const stamp = (): number => Date.now();\n',
  },
  // The browser has its own clock module, and only that one: a neighbour in
  // `apps/web` reading the time is refused like anywhere else. (#136)
  {
    rule: 'the clock is a dependency: Date.now() in apps/web outside system-clock.ts (D-46)',
    ruleId: 'no-restricted-syntax',
    path: 'apps/web/src/realtime/__enforcement__.ts',
    source: 'export const stamp = (): number => Date.now();\n',
  },
  // The escape hatches cost something (CONTRIBUTING.md §1.13, #136).
  {
    rule: 'a disable explains itself and links an issue (CONTRIBUTING.md §1.13)',
    ruleId: 'purlay/accountable-disable',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- needed for now\nexport const widen = (value: any): unknown => value;\n',
  },
  {
    rule: 'a disable names the rule it disables (CONTRIBUTING.md §1.13)',
    ruleId: 'purlay/accountable-disable',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: '// eslint-disable-next-line\nexport const widen = (value: any): unknown => value;\n',
  },
  {
    rule: 'no file-level disable (CONTRIBUTING.md §1.13)',
    ruleId: 'purlay/accountable-disable',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      '/* eslint-disable @typescript-eslint/no-explicit-any -- the whole file (#136) */\nexport const widen = (value: any): unknown => value;\n',
  },
  {
    rule: 'a disable that suppresses nothing fails the build (D-48)',
    ruleId: UNUSED_DISABLE,
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      "// eslint-disable-next-line no-console -- printing is not done here (#136)\nexport const quiet = 'nothing to suppress';\n",
  },
  {
    rule: 'a disable that names its rule, explains itself and links an issue is accepted',
    ruleId: 'purlay/accountable-disable',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      '// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stand-in until the contract types it (#136)\nexport const widen = (value: any): unknown => value;\n',
    allowed: true,
  },
  {
    rule: 'a TODO without an issue is refused (CONTRIBUTING.md §1.13)',
    ruleId: 'purlay/owned-debt',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: '// TODO make this faster\nexport const slow = 1;\n',
  },
  {
    rule: 'an expected type error in source links an issue (CONTRIBUTING.md §1.13)',
    ruleId: 'purlay/owned-expected-error',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: "// @ts-expect-error a string is not a number\nexport const wrong: number = 'x';\n",
  },
  // The type makes a context unforgeable; nothing in a type system stops an
  // assertion. This is the hole, and the rule that closes it. (D-21, D-54)
  {
    rule: 'a branded context may not be asserted into existence (D-54)',
    ruleId: 'no-restricted-syntax',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      "interface WorkspaceContext {\n  readonly workspaceId: string;\n}\nexport const forged = { workspaceId: 'w' } as WorkspaceContext;\n",
  },
];

interface EslintMessage {
  readonly ruleId: string | null;
  readonly message: string;
}
interface EslintResult {
  readonly filePath: string;
  readonly messages: readonly EslintMessage[];
}

/**
 * Each violation in a file of its own, in the directory its rule is scoped to.
 *
 * One lint run for all of them: a type-aware run costs about a second to start,
 * and running one per violation made this the slowest step of `verify` (#202).
 * The directory is what the path-scoped rules match; the index only keeps two
 * violations aimed at one directory from overwriting each other.
 */
const placed = VIOLATIONS.map((violation, index) => {
  const extension = extname(violation.path);
  const stem = basename(violation.path, extension).replace(
    /__enforcement__/,
    `__enforcement_${String(index)}__`,
  );
  // `.test.tsx` is part of what a rule matches; keep it whole.
  const suffix = violation.path.endsWith(`.test${extension}`) ? `.test${extension}` : extension;
  const name = `${stem.replace(/\.test$/, '')}${suffix}`;
  return { ...violation, file: join(dirname(violation.path), name) };
});

let failures = 0;
try {
  for (const violation of placed) {
    mkdirSync(dirname(violation.file), { recursive: true });
    writeFileSync(violation.file, violation.source);
  }

  const result = Bun.spawnSync(
    [
      'bun',
      'x',
      'eslint',
      '--no-warn-ignored',
      '--format',
      'json',
      ...placed.map((violation) => violation.file),
    ],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = result.stdout.toString().trim();
  if (stdout === '') {
    throw new Error(`eslint produced no report:\n${result.stderr.toString()}`);
  }
  const byFile = new Map(
    (JSON.parse(stdout) as readonly EslintResult[]).map((report) => [
      report.filePath,
      new Set(
        report.messages
          .map(
            (message) =>
              message.ruleId ??
              (message.message.startsWith('Unused eslint-disable directive')
                ? UNUSED_DISABLE
                : null),
          )
          .filter((id) => id !== null),
      ),
    ]),
  );

  for (const violation of placed) {
    const reported = byFile.get(join(process.cwd(), violation.file));
    // A file eslint did not report on at all is a failure, not a silence: it
    // means the file was ignored, and nothing about the rule was learned.
    if (reported === undefined) {
      failures += 1;
      console.log(`  NOT HELD ${violation.rule} — eslint did not lint ${violation.file}`);
    } else if (violation.allowed === true) {
      if (reported.has(violation.ruleId)) {
        failures += 1;
        console.log(
          `  REFUSED  ${violation.rule} — ${violation.ruleId} fired on a case it must accept`,
        );
      } else {
        console.log(`  ok       ${violation.rule}`);
      }
    } else if (reported.has(violation.ruleId)) {
      console.log(`  ok       ${violation.rule}`);
    } else {
      failures += 1;
      const instead = reported.size === 0 ? 'nothing' : [...reported].join(', ');
      console.log(
        `  NOT HELD ${violation.rule} — ${violation.ruleId} stayed silent, ${instead} fired`,
      );
    }
  }
} finally {
  // Always, or a throw above leaves a violation in the source tree.
  for (const violation of placed) rmSync(violation.file, { force: true });
}

/**
 * An export nothing imports is wired up or deleted (#136). Knip is not a lint
 * rule, so it is demonstrated here the same way: plant the violation, require the
 * build to name it, and first require a clean run with the plant's *used* export
 * alone — otherwise "knip failed" could be any unrelated finding or a crash.
 */
const KNIP_RULE = 'an export nothing imports fails the build (#136)';
const knipModule = 'apps/api/src/platform/__enforcement_knip__.ts';
const knipImporter = 'apps/api/src/platform/__enforcement_knip__.test.ts';
const knipReport = (): { readonly code: number; readonly report: string } => {
  const result = Bun.spawnSync(['bun', 'x', 'knip', '--reporter', 'json'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: result.exitCode, report: result.stdout.toString() };
};
try {
  writeFileSync(knipModule, 'export const used = 1;\n');
  writeFileSync(knipImporter, "import { used } from './__enforcement_knip__';\nvoid used;\n");
  const control = knipReport();
  writeFileSync(knipModule, 'export const used = 1;\nexport const unused = 2;\n');
  const planted = knipReport();
  if (control.code !== 0) {
    failures += 1;
    console.log(
      `  NOT HELD ${KNIP_RULE} — knip was not clean before the plant:\n${control.report}`,
    );
  } else if (planted.code === 0 || !planted.report.includes('"unused"')) {
    failures += 1;
    console.log(`  NOT HELD ${KNIP_RULE} — knip exited ${String(planted.code)}, naming nothing`);
  } else {
    console.log(`  ok       ${KNIP_RULE}`);
  }
} finally {
  rmSync(knipModule, { force: true });
  rmSync(knipImporter, { force: true });
}

if (failures > 0) {
  console.log(
    `\n${String(failures)} rule(s) the documents state are no longer enforced by the build.`,
  );
  process.exit(1);
}
console.log(`\nAll ${String(VIOLATIONS.length + 1)} stated rules are enforced by the build.`);
