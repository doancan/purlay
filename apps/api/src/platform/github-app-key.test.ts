/**
 * The App's key and the token it signs (D-246 §1): a key is one this server can sign with or it is refused, and
 * what it signs is what GitHub's documentation says GitHub takes — RS256, the client id as the issuer, issued a
 * minute back and gone within ten.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { appJwt, githubAppKeyProblem, normalisedKey } from './github-app-key';

const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const decoded = (part: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;

describe('the GitHub App’s key', () => {
  test('a PEM RSA key is one; anything else is refused without being quoted', () => {
    expect(githubAppKeyProblem(pair.privateKey)).toBeUndefined();
    const pkcs8 = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    expect(githubAppKeyProblem(pkcs8)).toBeUndefined();
    const ec = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    expect(githubAppKeyProblem(ec)).toBe('is not an RSA key, as GitHub generates');
    for (const nonsense of ['', 'not a key', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END']) {
      expect(githubAppKeyProblem(nonsense)).toBe('is not a PEM private key');
    }
  });

  test('a key pasted with its line breaks written out reads as the key', () => {
    const oneLine = pair.privateKey.trim().replaceAll('\n', '\\n');
    expect(normalisedKey(oneLine)).toBe(pair.privateKey.trim());
    expect(githubAppKeyProblem(oneLine)).toBeUndefined();
  });

  test('signs an RS256 token for the client id, issued a minute back, living nine minutes', () => {
    const now = new Date('2026-11-01T12:00:00.000Z');
    const token = appJwt('Iv23.app', pair.privateKey, now);
    const [header, payload, signature] = token.split('.');
    expect(decoded(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const issued = now.getTime() / 1000 - 60;
    expect(decoded(payload)).toEqual({ iat: issued, exp: issued + 540, iss: 'Iv23.app' });
    expect(
      createVerify('RSA-SHA256')
        .update(`${header ?? ''}.${payload ?? ''}`)
        .verify(pair.publicKey, Buffer.from(signature ?? '', 'base64url')),
    ).toBe(true);
  });
});
