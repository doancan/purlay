import { createPrivateKey } from 'node:crypto';

export const APNS_IDENTIFIER = /^[A-Z0-9]{10}$/;
export const APNS_TOPIC = /^[A-Za-z0-9.-]{1,255}$/;

export interface ApnsCredentials {
  readonly environment: 'sandbox' | 'production';
  readonly topic: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly signingKey: string;
}

/** Check the unencrypted PKCS#8 P-256 key Apple supplies, accepting escaped line breaks. */
export const apnsSigningKey = (value: string): string | undefined => {
  const pem = value.replaceAll('\\n', '\n').trim();
  if (
    !/^-----BEGIN PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END PRIVATE KEY-----$/.test(
      pem,
    )
  )
    return undefined;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1')
      return pem;
  } catch {
    // The decoder's error is deliberately kept out of configuration and worker output.
  }
  return undefined;
};
