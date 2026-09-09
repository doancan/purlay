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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

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
}

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
  {
    rule: 'layering: the browser may not import the database (ARCHITECTURE.md §4)',
    ruleId: 'no-restricted-imports',
    path: 'apps/web/src/__enforcement__.ts',
    source: "import { db } from '@purlay/db';\n\nexport const use = (): unknown => db;\n",
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
}
interface EslintResult {
  readonly messages: readonly EslintMessage[];
}

/** Which rules actually reported on this file. A parse error reports `null` and counts for nothing. */
const rulesReported = (target: string): ReadonlySet<string> => {
  const result = Bun.spawnSync(
    ['bun', 'x', 'eslint', '--no-warn-ignored', '--format', 'json', target],
    { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
  );
  const stdout = result.stdout.toString().trim();
  if (stdout === '') {
    throw new Error(`eslint produced no report for ${target}:\n${result.stderr.toString()}`);
  }
  const reports = JSON.parse(stdout) as readonly EslintResult[];
  return new Set(
    reports.flatMap((report) =>
      report.messages.map((message) => message.ruleId).filter((id) => id !== null),
    ),
  );
};

let failures = 0;
const scratch = mkdtempSync(join(tmpdir(), 'purlay-enforcement-'));

for (const violation of VIOLATIONS) {
  const absolute = join(process.cwd(), violation.path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, violation.source);
  const reported = rulesReported(violation.path);
  rmSync(absolute, { force: true });

  if (reported.has(violation.ruleId)) {
    console.log(`  ok       ${violation.rule}`);
  } else {
    failures += 1;
    const instead = reported.size === 0 ? 'nothing' : [...reported].join(', ');
    console.log(
      `  NOT HELD ${violation.rule} — ${violation.ruleId} stayed silent, ${instead} fired`,
    );
  }
}
rmSync(scratch, { recursive: true, force: true });

if (failures > 0) {
  console.log(
    `\n${String(failures)} rule(s) the documents state are no longer enforced by the build.`,
  );
  process.exit(1);
}
console.log(`\nAll ${String(VIOLATIONS.length)} stated rules are enforced by the build.`);
