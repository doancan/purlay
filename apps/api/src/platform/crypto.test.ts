/**
 * The one credential cipher (D-39 §6, #113): AES-256-GCM under a key derived from `ENCRYPTION_KEY`,
 * a fresh 96-bit nonce per seal stored in front of the ciphertext, and the record's id bound in as
 * additional authenticated data — so a sealed value opens only with the same key, for the same
 * record, unaltered.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEAL_VERSION, SealBroken, credentialCipher } from './crypto';

const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64');
const ID = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const OTHER = '0199155c-6200-7b7f-8c11-2a4d3f9e1b71';

const brokenBy = async (attempt: Promise<unknown>): Promise<string> =>
  await attempt.then(
    () => 'opened',
    (error: unknown) => (error instanceof SealBroken ? 'SealBroken' : String(error)),
  );

describe('the credential cipher', () => {
  test('opens what it sealed, for the same record: text of any kind', async () => {
    const cipher = await credentialCipher(key(1));
    for (const secret of ['ghp_abc123', '', 'şifre ğüş 🔑']) {
      expect(await cipher.open(await cipher.seal(secret, ID), ID)).toBe(secret);
    }
  });

  test('is its version, a 12-byte nonce, the ciphertext and a 16-byte tag; never the same twice', async () => {
    const cipher = await credentialCipher(key(1));
    const first = await cipher.seal('ghp_abc123', ID);
    const second = await cipher.seal('ghp_abc123', ID);
    expect(first[0]).toBe(SEAL_VERSION);
    expect(first.length).toBe(1 + 12 + 'ghp_abc123'.length + 16);
    expect(first.subarray(1, 13)).not.toEqual(second.subarray(1, 13));
    expect(first).not.toEqual(second);
  });

  test('does not open for another record, under another key, or altered by one bit', async () => {
    const cipher = await credentialCipher(key(1));
    const sealed = await cipher.seal('ghp_abc123', ID);
    expect(await brokenBy(cipher.open(sealed, OTHER))).toBe('SealBroken');
    expect(await brokenBy((await credentialCipher(key(2))).open(sealed, ID))).toBe('SealBroken');
    for (const at of [0, 5, sealed.length - 1]) {
      const altered = Uint8Array.from(sealed);
      altered[at] = (altered[at] ?? 0) ^ 1;
      expect({ at, outcome: await brokenBy(cipher.open(altered, ID)) }).toEqual({
        at,
        outcome: 'SealBroken',
      });
    }
    expect(await brokenBy(cipher.open(sealed.subarray(0, 10), ID))).toBe('SealBroken');
  });

  test('is under a key of its own, not the root: the OAuth state key and this cannot interact', async () => {
    const root = Buffer.alloc(32, 1);
    const sealed = await (await credentialCipher(root.toString('base64'))).seal('x', ID);
    const underRoot = await crypto.subtle.importKey('raw', root, 'AES-GCM', false, ['decrypt']);
    const opened = await crypto.subtle
      .decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(sealed.subarray(1, 13)),
          additionalData: new TextEncoder().encode(ID),
        },
        underRoot,
        new Uint8Array(sealed.subarray(13)),
      )
      .then(
        () => 'opened',
        () => 'refused',
      );
    expect(opened).toBe('refused');
  });
});

describe('one cipher (#113)', () => {
  test('no other production source encrypts or decrypts', () => {
    const root = join(import.meta.dir, '..', '..', '..', '..');
    const sources = ['apps/api/src', 'packages/db/src'].flatMap((dir) =>
      readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
        .filter(
          (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'),
        )
        .map((entry) => join(entry.parentPath, entry.name)),
    );
    const encrypting = sources.filter((path) =>
      /createCipheriv|createDecipheriv|subtle\.(en|de)crypt|'AES-GCM'/.test(
        readFileSync(path, 'utf8'),
      ),
    );
    expect(encrypting.map((path) => path.slice(root.length + 1))).toEqual([
      'apps/api/src/platform/crypto.ts',
    ]);
  });
});
