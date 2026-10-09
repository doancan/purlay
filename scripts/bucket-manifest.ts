/**
 * What a bucket backup is made of, and how to tell two of them apart (#248, D-95).
 *
 * A backup that cannot be compared with what it came from is a hope. Every object
 * is recorded with its size and the SHA-256 of its bytes; a restore is judged by
 * whether the bucket it produced has the same manifest, not by whether the copy
 * command exited 0.
 *
 * Kept free of any network or filesystem access so it can be tested without a
 * bucket; `bucket-copy.ts` is the part that talks to one.
 */
import { join, resolve, sep } from 'node:path';

export interface ManifestEntry {
  readonly key: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * Where an object key lands under a backup directory. Keys are opaque strings the
 * application chose, but a restore reads them back from a file somebody could
 * have edited, so a key that would climb out of the directory is refused rather
 * than written: `../../etc/cron.d/x` is a valid S3 key.
 */
export const objectPath = (root: string, key: string): string => {
  const base = resolve(root);
  // Segment by segment, because path normalisation would quietly merge distinct
  // keys: `a//b`, `a/./b` and `/a/b` all land on the file `a/b`, and the export
  // would overwrite one object with another and report success.
  const segments = key.split('/');
  const target = resolve(join(base, key));
  if (
    key.includes('\0') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    !target.startsWith(base + sep)
  ) {
    throw new Error(
      `refusing an object key that does not map to one file inside the backup: ${JSON.stringify(key)}`,
    );
  }
  return target;
};

export const sha256Hex = (bytes: Uint8Array): string => {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
};

/** Sorted by key, so two manifests of the same contents are identical text. */
export const sortedManifest = (entries: readonly ManifestEntry[]): ManifestEntry[] =>
  [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

export const parseManifest = (text: string): ManifestEntry[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('the manifest must be an array');
  return sortedManifest(
    parsed.map((entry: unknown, index): ManifestEntry => {
      if (typeof entry !== 'object' || entry === null) {
        throw new Error(`manifest entry ${String(index + 1)} is not an object`);
      }
      const { key, size, sha256 } = entry as Record<string, unknown>;
      if (
        typeof key !== 'string' ||
        typeof size !== 'number' ||
        !Number.isInteger(size) ||
        size < 0 ||
        typeof sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(sha256)
      ) {
        throw new Error(`manifest entry ${String(index + 1)} is malformed`);
      }
      return { key, size, sha256 };
    }),
  );
};

/** Every way the second manifest differs from the first; empty means identical. */
export const differences = (
  expected: readonly ManifestEntry[],
  actual: readonly ManifestEntry[],
): string[] => {
  const problems: string[] = [];
  const have = new Map(actual.map((entry) => [entry.key, entry]));
  const want = new Map(expected.map((entry) => [entry.key, entry]));
  for (const entry of expected) {
    const found = have.get(entry.key);
    if (found === undefined) problems.push(`missing: ${entry.key}`);
    else if (found.size !== entry.size) {
      problems.push(`size differs: ${entry.key} (${String(entry.size)} -> ${String(found.size)})`);
    } else if (found.sha256 !== entry.sha256) problems.push(`content differs: ${entry.key}`);
  }
  for (const entry of actual) if (!want.has(entry.key)) problems.push(`unexpected: ${entry.key}`);
  return problems;
};
