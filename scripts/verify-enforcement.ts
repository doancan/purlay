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
  /** Path relative to the repository root — the layering rules are path-scoped. */
  readonly path: string;
  readonly source: string;
}

const VIOLATIONS: readonly Violation[] = [
  {
    rule: 'no-explicit-any (CONTRIBUTING.md §1.3)',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: 'export const widen = (value: any): unknown => value;\n',
  },
  {
    rule: 'no-floating-promises (D-47)',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source:
      'const work = async (): Promise<void> => {};\nexport const go = (): void => {\n  work();\n};\n',
  },
  {
    rule: 'explicit-function-return-type (CONTRIBUTING.md §1.3)',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: 'export function add(a: number, b: number) {\n  return a + b;\n}\n',
  },
  {
    rule: 'layering: a module may not import from ingress (ARCHITECTURE.md §4)',
    path: 'apps/api/src/modules/__enforcement__.ts',
    source:
      "import { thing } from '../ingress/http/routes';\n\nexport const use = (): unknown => thing;\n",
  },
  {
    rule: 'layering: the browser may not import the database (ARCHITECTURE.md §4)',
    path: 'apps/web/src/__enforcement__.ts',
    source: "import { db } from '@purlay/db';\n\nexport const use = (): unknown => db;\n",
  },
  {
    rule: 'ban-ts-comment: @ts-ignore is prohibited (D-47)',
    path: 'apps/api/src/platform/__enforcement__.ts',
    source: '// @ts-ignore\nexport const broken: number = "not a number";\n',
  },
];

const lint = (target: string): boolean => {
  const result = Bun.spawnSync(['bun', 'x', 'eslint', '--no-warn-ignored', target], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return result.exitCode !== 0;
};

let failures = 0;
const scratch = mkdtempSync(join(tmpdir(), 'purlay-enforcement-'));

for (const violation of VIOLATIONS) {
  const absolute = join(process.cwd(), violation.path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, violation.source);
  const rejected = lint(violation.path);
  rmSync(absolute, { force: true });

  if (rejected) {
    console.log(`  ok       ${violation.rule}`);
  } else {
    failures += 1;
    console.log(`  NOT HELD ${violation.rule}`);
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
