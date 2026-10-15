/**
 * Fails when something installed cannot ship inside an AGPL-3.0 distribution
 * (`licenses.ts`, #247).
 *
 *   bun install --frozen-lockfile && bun run check:licenses
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installedPackages, judgeLicenses, resolvedByLockfile } from './licenses';

// What the lockfile resolves, not every manifest a long-lived store still holds (#675).
const packages = resolvedByLockfile(
  installedPackages(process.cwd()),
  readFileSync(join(process.cwd(), 'bun.lock'), 'utf8'),
);
const verdict = judgeLicenses(packages);

const counts = new Map<string, number>();
for (const pkg of packages) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${license || '(none declared)'}`);
}
for (const problem of verdict.problems) console.error(`  PROBLEM  ${problem}`);
console.log(
  verdict.ok
    ? `licences: ${String(packages.length)} packages, all compatible with AGPL-3.0`
    : 'licences: FAILED',
);
process.exit(verdict.ok ? 0 : 1);
