/**
 * Copies the attachment bucket to a directory and back (#248, D-95).
 *
 *   bucket-copy.ts export <dir>   every object -> <dir>/objects/<key>, and <dir>/manifest.json
 *   bucket-copy.ts import <dir>   the objects back into an EMPTY bucket, verified against the manifest
 *   bucket-copy.ts verify <dir>   re-reads the bucket and compares it to the manifest
 *   bucket-copy.ts count          how many objects the bucket holds
 *
 * It reads the bucket the application is configured with (`S3_*`, docs/CONFIG.md) and
 * uses the runtime's own S3 client, so it needs nothing the API image does not
 * already contain. `scripts/backup.sh` runs it inside that image, on the stack's
 * network, because the object store is published nowhere.
 *
 * **Import refuses a bucket that has anything in it.** A restore that merges into
 * existing objects cannot say what it produced.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { S3Client } from 'bun';
import {
  differences,
  objectPath,
  parseManifest,
  sha256Hex,
  sortedManifest,
  type ManifestEntry,
} from './bucket-manifest';

const environment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set (docs/CONFIG.md)`);
  return value;
};

const client = new S3Client({
  endpoint: environment('S3_ENDPOINT'),
  region: process.env['S3_REGION'] ?? 'us-east-1',
  bucket: environment('S3_BUCKET'),
  accessKeyId: environment('S3_ACCESS_KEY_ID'),
  secretAccessKey: environment('S3_SECRET_ACCESS_KEY'),
});

/** Every key in the bucket, following the listing's continuation. */
const listKeys = async (): Promise<string[]> => {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.list(token === undefined ? {} : { continuationToken: token });
    keys.push(...(page.contents ?? []).map((object) => object.key));
    token = page.isTruncated === true ? page.nextContinuationToken : undefined;
  } while (token !== undefined);
  return keys.sort();
};

/** Reads every object and records what it saw. */
const snapshot = async (): Promise<{
  manifest: ManifestEntry[];
  bytes: Map<string, Uint8Array>;
}> => {
  const bytes = new Map<string, Uint8Array>();
  const entries: ManifestEntry[] = [];
  for (const key of await listKeys()) {
    const content = await client.file(key).bytes();
    bytes.set(key, content);
    entries.push({ key, size: content.byteLength, sha256: sha256Hex(content) });
  }
  return { manifest: sortedManifest(entries), bytes };
};

const [command, directory] = process.argv.slice(2);
if (command === 'count') {
  // How many objects the bucket holds: what a restore asks before it touches anything.
  console.log(String((await listKeys()).length));
  process.exit(0);
}
if (directory === undefined || !['export', 'import', 'verify'].includes(command ?? '')) {
  console.error('usage: bucket-copy.ts export|import|verify <dir> | count');
  process.exit(2);
}
const manifestFile = join(directory, 'manifest.json');
const objectsDirectory = join(directory, 'objects');

if (command === 'export') {
  const { manifest, bytes } = await snapshot();
  for (const entry of manifest) {
    const target = objectPath(objectsDirectory, entry.key);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes.get(entry.key) ?? new Uint8Array());
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const total = manifest.reduce((sum, entry) => sum + entry.size, 0);
  console.log(
    `exported ${String(manifest.length)} objects, ${String(total)} bytes -> ${directory}`,
  );
} else if (command === 'import') {
  const manifest = parseManifest(readFileSync(manifestFile, 'utf8'));
  const existing = await listKeys();
  if (existing.length > 0) {
    console.error(
      `refusing to import into a bucket that already holds ${String(existing.length)} objects`,
    );
    process.exit(1);
  }
  for (const entry of manifest) {
    const content = new Uint8Array(readFileSync(objectPath(objectsDirectory, entry.key)));
    // The file on disk must be what the manifest says before it is trusted.
    if (content.byteLength !== entry.size || sha256Hex(content) !== entry.sha256) {
      throw new Error(`${entry.key}: the backup copy does not match its manifest`);
    }
    await client.write(entry.key, content);
  }
  const problems = differences(manifest, (await snapshot()).manifest);
  if (problems.length > 0) {
    console.error(`the restored bucket differs from the backup:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`imported ${String(manifest.length)} objects; the bucket matches the manifest`);
} else {
  const problems = differences(
    parseManifest(readFileSync(manifestFile, 'utf8')),
    (await snapshot()).manifest,
  );
  if (problems.length > 0) {
    console.error(`the bucket differs from the manifest:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('the bucket matches the manifest');
}
