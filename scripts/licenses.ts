/**
 * Can everything installed ship inside an AGPL-3.0 distribution? (#247)
 *
 * Purlay is AGPL-3.0 software with a commercial licence offered beside it
 * (D-24), which is stricter than "free software": the project must be able to
 * offer a dependency's code under both. So the check is a **allow-list of
 * licences known to combine with the AGPL**, not a list of bad ones. A
 * licence the check has never heard of fails and is decided by a person in a
 * pull request that adds it here — an unknown is the case a deny-list passes.
 *
 * It reads the installed tree rather than the lockfile because the lockfile
 * does not carry licences; what is on disk is what would be shipped. Optional
 * native binaries differ by platform, so CI (Linux) and a laptop see slightly
 * different sets; CI's is the one that counts.
 *
 * The functions here are pure or read the filesystem under a root they are
 * given; `check-licenses.ts` is the entry point.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { join } from 'node:path';

/**
 * SPDX identifiers whose terms combine with AGPL-3.0, with the reason where it
 * is not obvious. Permissive licences carry no condition the AGPL does not
 * already satisfy; Apache-2.0 is compatible with version 3 of the GPL family
 * (not with version 2). MPL-2.0 permits combination under the GPL family
 * through its secondary-licence clause. The GPL and LGPL entries are the
 * version-3-compatible ones.
 */
const ALLOWED = new Set([
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'MPL-2.0',
  'Python-2.0',
  'Unicode-3.0',
  'Unicode-DFS-2016',
  'Unlicense',
  'WTFPL',
  'Zlib',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'GPL-2.0-or-later',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
]);

export interface Check {
  readonly ok: boolean;
  readonly reason: string;
}

const tokenize = (expression: string): string[] =>
  expression
    .replace(/([()])/g, ' $1 ')
    .split(/\s+/)
    .filter((token) => token !== '');

/** An id is allowed, or its legacy `+` ("or later") form is, for the GPL family. */
const idAllowed = (id: string): boolean =>
  ALLOWED.has(id) || (id.endsWith('+') && /^L?A?GPL-/.test(id) && !id.startsWith('GPL-1'));

/**
 * Evaluates an SPDX licence expression: `OR` is satisfied by either side (the
 * consumer picks), `AND` needs both, `WITH exception` is judged by the licence
 * it modifies. Anything it cannot parse is not allowed.
 */
export const checkExpression = (expression: string): Check => {
  const tokens = tokenize(expression);
  if (tokens.length === 0) return { ok: false, reason: 'no licence is declared' };

  let position = 0;
  const failed: string[] = [];
  const peek = (): string => tokens[position] ?? '';
  const isKeyword = (word: string): boolean => peek().toUpperCase() === word;

  const atom = (): boolean | undefined => {
    if (peek() === '(') {
      position += 1;
      const inner = or();
      if (peek() !== ')') return undefined;
      position += 1;
      return inner;
    }
    const id = peek();
    if (id === '' || id === ')' || isKeyword('AND') || isKeyword('OR') || isKeyword('WITH')) {
      return undefined;
    }
    position += 1;
    if (isKeyword('WITH')) {
      position += 2;
    }
    const allowed = idAllowed(id);
    if (!allowed) failed.push(id);
    return allowed;
  };

  const and = (): boolean | undefined => {
    let result = atom();
    while (result !== undefined && isKeyword('AND')) {
      position += 1;
      const next = atom();
      result = next === undefined ? undefined : result && next;
    }
    return result;
  };

  function or(): boolean | undefined {
    let result = and();
    while (result !== undefined && isKeyword('OR')) {
      position += 1;
      const next = and();
      result = next === undefined ? undefined : result || next;
    }
    return result;
  }

  const verdict = or();
  if (verdict === undefined || position !== tokens.length) {
    return { ok: false, reason: `"${expression}" is not a licence expression this check can read` };
  }
  return verdict
    ? { ok: true, reason: 'allowed' }
    : { ok: false, reason: `${failed.join(', ')} cannot be combined with AGPL-3.0` };
};

export interface InstalledPackage {
  readonly name: string;
  readonly version: string;
  /** The licence as an SPDX expression, or `''` when the manifest declares none. */
  readonly license: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The licence in a manifest: the `license` string, the legacy `{type}` object, or the legacy `licenses` array. */
const declaredLicense = (manifest: Record<string, unknown>): string => {
  const { license, licenses } = manifest;
  if (typeof license === 'string') return license.trim();
  if (isRecord(license) && typeof license['type'] === 'string') return license['type'].trim();
  if (Array.isArray(licenses)) {
    const types = licenses.flatMap((entry: unknown) =>
      isRecord(entry) && typeof entry['type'] === 'string' ? [entry['type'].trim()] : [],
    );
    return types.length === 0 ? '' : `(${types.join(' OR ')})`;
  }
  return '';
};

/** Where Bun's isolated install keeps real packages, plus a hoisted layout's. */
const PACKAGE_MANIFESTS = [
  '.bun/*/node_modules/*/package.json',
  '.bun/*/node_modules/@*/*/package.json',
  '*/package.json',
  '@*/*/package.json',
];

/**
 * Every package installed under `root/node_modules`, once per name and version.
 * Throws when it finds none: a check that read an empty directory has measured
 * nothing, and "no problems" would be a lie (CONTRIBUTING §6.4).
 */
export const installedPackages = (root: string): readonly InstalledPackage[] => {
  const modules = join(root, 'node_modules');
  const found = new Map<string, InstalledPackage>();
  if (!existsSync(modules))
    throw new Error(`no installed packages found: ${modules} does not exist`);

  for (const pattern of PACKAGE_MANIFESTS) {
    const glob = new Glob(pattern);
    for (const file of glob.scanSync({ cwd: modules, dot: true, onlyFiles: true })) {
      const manifest: unknown = JSON.parse(readFileSync(join(modules, file), 'utf8'));
      if (!isRecord(manifest)) continue;
      const { name, version } = manifest;
      if (typeof name !== 'string' || typeof version !== 'string') continue;
      found.set(`${name}@${version}`, { name, version, license: declaredLicense(manifest) });
    }
  }

  if (found.size === 0) throw new Error(`no installed packages found under ${modules}`);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
};

export interface Verdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

export const judgeLicenses = (packages: readonly InstalledPackage[]): Verdict => {
  const problems = packages.flatMap((pkg) => {
    const check = checkExpression(pkg.license);
    return check.ok
      ? []
      : [`${pkg.name}@${pkg.version} (${pkg.license || 'none'}): ${check.reason}`];
  });
  return { ok: problems.length === 0, problems };
};
