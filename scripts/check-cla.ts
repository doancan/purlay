/**
 * `bun run check:cla <pull request>`: may it be merged under the contributor licence agreement
 * (#122, D-145)? The rule is `contributor-agreement.ts`; this reads the author and the base through
 * `gh`, the signatures as the pull request leaves them from the checkout, and as the base has them
 * through the API — a shallow checkout does not hold the base.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claVerdict, maintainersIn, parseSignatures } from './contributor-agreement';

const root = join(import.meta.dir, '..');
const SIGNATURES = '.github/cla-signatures.json';

const run = (args: readonly string[]): { readonly ok: boolean; readonly out: string } => {
  const result = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: result.exitCode === 0,
    out: (result.exitCode === 0 ? result.stdout : result.stderr).toString(),
  };
};

const number = process.argv[2];
if (number === undefined || !/^\d+$/.test(number)) {
  console.error('usage: bun run check:cla <pull request number>');
  process.exit(1);
}

const pull = run(['pr', 'view', number, '--json', 'author,baseRefName']);
if (!pull.ok) {
  console.error(`gh pr view ${number} failed:\n${pull.out}`);
  process.exit(1);
}
const { author, baseRefName } = JSON.parse(pull.out) as {
  author: { login: string };
  baseRefName: string;
};

// The base's signatures: a 404 is a base that has none yet; anything else is said and fails.
const base = run([
  'api',
  `repos/{owner}/{repo}/contents/${SIGNATURES}?ref=${encodeURIComponent(baseRefName)}`,
  '--jq',
  '.content',
]);
if (!base.ok && !base.out.includes('HTTP 404')) {
  console.error(`reading ${SIGNATURES} on ${baseRefName} failed:\n${base.out}`);
  process.exit(1);
}
const before = base.ok
  ? parseSignatures(Buffer.from(base.out.trim(), 'base64').toString('utf8'))
  : [];
const after = parseSignatures(readFileSync(join(root, SIGNATURES), 'utf8'));
const maintainers = maintainersIn(readFileSync(join(root, '.github/CODEOWNERS'), 'utf8'));

const verdict = claVerdict({ author: author.login, maintainers, before, after });
if (verdict.allowed) {
  console.log(`#${number}: may be merged under the contributor licence agreement (${verdict.why})`);
} else {
  console.error(`#${number} cannot be merged: ${verdict.why}`);
  process.exit(1);
}
