/**
 * Fails when something installed cannot ship inside an AGPL-3.0 distribution
 * (`licenses.ts`, #247).
 *
 *   bun install --frozen-lockfile && bun run check:licenses
 */
import { installedPackages, judgeLicenses } from './licenses';

const packages = installedPackages(process.cwd());
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
