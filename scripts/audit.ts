/**
 * Runs the dependency audit and judges it (`audit-gate.ts`, #247).
 *
 *   bun run audit
 *
 * Today's date is an argument, not a read of the clock (D-46); the package script
 * supplies it. Exits 1 on any problem and prints each.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeAudit, parseAllowlist, parseAudit } from './audit-gate';

const todayIndex = process.argv.indexOf('--today');
const today = todayIndex === -1 ? undefined : process.argv[todayIndex + 1];
if (today === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
  console.error('usage: bun run scripts/audit.ts --today YYYY-MM-DD');
  process.exit(2);
}

// `bun audit` exits non-zero when it finds anything, so the exit code is not the
// signal; the report is. An audit that could not run prints no JSON, which
// `parseAudit` refuses.
const audit = Bun.spawnSync(['bun', 'audit', '--json'], { stdout: 'pipe', stderr: 'pipe' });
const output = audit.stdout.toString();
if (output.trim() === '') {
  console.error(
    `bun audit printed nothing (exit ${String(audit.exitCode)}): ${audit.stderr.toString()}`,
  );
  process.exit(1);
}

const verdict = judgeAudit({
  findings: parseAudit(output),
  allowlist: parseAllowlist(readFileSync(join(import.meta.dir, 'audit-allowlist.json'), 'utf8')),
  today,
});

for (const note of verdict.notes) console.log(`  note     ${note}`);
for (const problem of verdict.problems) console.error(`  PROBLEM  ${problem}`);
console.log(verdict.ok ? 'audit gate: passed' : 'audit gate: FAILED');
process.exit(verdict.ok ? 0 : 1);
