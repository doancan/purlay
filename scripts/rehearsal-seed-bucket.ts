/**
 * Fills the attachment bucket with objects worth restoring (scripts/restore-rehearsal.sh).
 * Runs inside the API image, on the rehearsal stack's network. Sizes cross the
 * single-request and multipart boundaries; one key has non-ASCII characters; one
 * object is a single byte.
 */
import { S3Client } from 'bun';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
};

const client = new S3Client({
  endpoint: required('S3_ENDPOINT'),
  region: 'us-east-1',
  bucket: required('S3_BUCKET'),
  accessKeyId: required('S3_ACCESS_KEY_ID'),
  secretAccessKey: required('S3_SECRET_ACCESS_KEY'),
});

let total = 0;
const put = async (key: string, size: number): Promise<void> => {
  // Random but different per object, so two objects of one size are not
  // interchangeable and a restore that swapped them would be seen.
  const body = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65_536) {
    crypto.getRandomValues(body.subarray(offset, Math.min(offset + 65_536, size)));
  }
  await client.write(key, body);
  total += size;
};

for (let i = 0; i < 40; i += 1) {
  await put(
    `attachments/${(i % 16).toString(16)}${String(i % 7)}/file-${String(i)}.bin`,
    1000 + i * 977,
  );
}
await put('attachments/big/five-mib.bin', 5 * 1024 * 1024);
await put('attachments/big/twelve-mib-multipart.bin', 12 * 1024 * 1024);
await put('attachments/unicode/İstanbul ıspanak 🚀.txt', 321);
await put('attachments/tiny/one-byte', 1);
console.log(`seeded 44 objects, ${String(total)} bytes`);
