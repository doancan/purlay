/**
 * The GitHub App's private key (D-246 §1): what makes a key one this server can sign with, and the short-lived
 * JSON Web Token GitHub takes as the App itself — apart from the App's module so that the configuration, the
 * server's settings and the probe can all ask it without loading anything else.
 *
 * GitHub's documentation ("Generating a JSON Web Token (JWT) for a GitHub App"): RS256, the App's client id as
 * `iss`, issued sixty seconds in the past against clock drift, and expiring at most ten minutes after it was
 * issued. The key GitHub generates is a PEM RSA key (PKCS#1); a PKCS#8 one is taken too.
 */
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

/** GitHub refuses a token that lives longer than ten minutes; nine leaves room for a skewed clock. */
const LIFETIME_SECONDS = 9 * 60;
/** Issued in the past, as GitHub recommends, so a clock a little ahead of GitHub's is believed. */
const BACKDATE_SECONDS = 60;

/**
 * A key as pasted: an environment file cannot hold a line break, so `\n` written out is taken as one. Only
 * that; anything else is the key as given.
 */
export const normalisedKey = (pem: string): string => pem.trim().replaceAll('\\n', '\n');

// A string is read as PEM, which is all that is wanted of it.
const keyOf = (pem: string): KeyObject => createPrivateKey(normalisedKey(pem));

/** Why `pem` is not a key this server can sign with, or nothing. The reason never quotes the value. */
export const githubAppKeyProblem = (pem: string): string | undefined => {
  let key: KeyObject;
  try {
    key = keyOf(pem);
  } catch {
    return 'is not a PEM private key';
  }
  if (key.asymmetricKeyType !== 'rsa') return 'is not an RSA key, as GitHub generates';
  return undefined;
};

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/** A token GitHub takes as the App, for nine minutes from `now`. Throws on a key `githubAppKeyProblem` refuses. */
export const appJwt = (clientId: string, pem: string, now: Date): string => {
  const issued = Math.floor(now.getTime() / 1000) - BACKDATE_SECONDS;
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iat: issued, exp: issued + LIFETIME_SECONDS, iss: clientId }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(keyOf(pem));
  return `${header}.${payload}.${base64url(signature)}`;
};
