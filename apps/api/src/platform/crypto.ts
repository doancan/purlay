/**
 * The one credential cipher (D-39 §6, #113). Every secret Purlay stores — the workspace's GitHub
 * token first (#65) — is sealed here and nowhere else, so two call sites cannot encrypt differently;
 * `crypto.test.ts` holds that no other production source encrypts.
 *
 * - **AES-256-GCM**, under a key derived from `ENCRYPTION_KEY` with domain separation
 *   (`HMAC(root, "purlay:credential:v1")`, as D-62 derives the OAuth state key): the two keys cannot
 *   interact, and neither is the root.
 * - **A fresh random 96-bit nonce per seal**, stored in front of the ciphertext. Random nonces under
 *   one key are safe for far more records than this table will hold.
 * - **The record's id as additional authenticated data**: a sealed value copied onto another row
 *   does not open there.
 * - **A version byte first**, so a later key or algorithm can be told from this one without guessing.
 *
 * A value that does not open — another key, another record, altered, truncated — is `SealBroken`:
 * the caller's to report, never a secret quietly treated as missing.
 */

/** The layout this writes: version, then the nonce, then the ciphertext and its 16-byte tag. */
export const SEAL_VERSION = 1;
const NONCE_BYTES = 12;
const PURPOSE = 'purlay:credential:v1';

export class SealBroken extends Error {
  constructor() {
    super('a sealed credential did not open: another key, another record, or altered');
    this.name = 'SealBroken';
  }
}

export interface CredentialCipher {
  readonly seal: (secret: string, recordId: string) => Promise<Uint8Array>;
  readonly open: (sealed: Uint8Array, recordId: string) => Promise<string>;
}

/** Made at boot without waiting: the key is derived on first use, once. */
export const credentialCipher = (rootBase64: string): CredentialCipher => {
  let derivedKey: Promise<CryptoKey> | undefined;
  const keyOf = async (): Promise<CryptoKey> => {
    derivedKey ??= (async (): Promise<CryptoKey> => {
      const root = await crypto.subtle.importKey(
        'raw',
        Buffer.from(rootBase64, 'base64'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const derived = await crypto.subtle.sign('HMAC', root, new TextEncoder().encode(PURPOSE));
      return await crypto.subtle.importKey('raw', derived, 'AES-GCM', false, [
        'encrypt',
        'decrypt',
      ]);
    })();
    return await derivedKey;
  };
  const bound = (recordId: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(recordId);

  return {
    seal: async (secret, recordId): Promise<Uint8Array> => {
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: nonce, additionalData: bound(recordId) },
          await keyOf(),
          new TextEncoder().encode(secret),
        ),
      );
      const sealed = new Uint8Array(1 + NONCE_BYTES + ciphertext.length);
      sealed[0] = SEAL_VERSION;
      sealed.set(nonce, 1);
      sealed.set(ciphertext, 1 + NONCE_BYTES);
      return sealed;
    },
    open: async (given, recordId): Promise<string> => {
      // A copy on a buffer of its own: what the database hands back may be a view into a larger one.
      const sealed = new Uint8Array(given);
      if (sealed.length < 1 + NONCE_BYTES + 16 || sealed[0] !== SEAL_VERSION) {
        throw new SealBroken();
      }
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: sealed.subarray(1, 1 + NONCE_BYTES),
            additionalData: bound(recordId),
          },
          await keyOf(),
          sealed.subarray(1 + NONCE_BYTES),
        );
        return new TextDecoder().decode(plaintext);
      } catch {
        // WebCrypto says only "OperationError": what failed is the seal, and nothing else is known.
        throw new SealBroken();
      }
    },
  };
};
