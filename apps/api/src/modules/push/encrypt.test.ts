/**
 * RFC 8291's own worked example (Appendix A), reproduced byte for byte: the encryption is the
 * standard's or it is nothing a browser can open. And a real send's fresh parts are fresh.
 */
import { describe, expect, test } from 'bun:test';
import { encryptPush, freshParts } from './encrypt';

const APPENDIX_A = {
  plaintext: 'When I grow up, I want to be a watermelon',
  serverPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  serverPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  browserPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

const from = (base64url: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(base64url, 'base64url'));

/** The example's one-message key pair, imported as the spike found it must be: a JWK. */
const examplePair = async (): Promise<CryptoKeyPair> => {
  const point = from(APPENDIX_A.serverPublic);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(point.subarray(33, 65)).toString('base64url'),
  };
  const algorithm = { name: 'ECDH', namedCurve: 'P-256' };
  return {
    privateKey: await crypto.subtle.importKey(
      'jwk',
      { ...jwk, d: APPENDIX_A.serverPrivate },
      algorithm,
      true,
      ['deriveBits'],
    ),
    publicKey: await crypto.subtle.importKey('raw', point, algorithm, true, []),
  };
};

describe('a push, encrypted for one browser (RFC 8291)', () => {
  test('is the standard’s own example, byte for byte', async () => {
    const body = await encryptPush(
      { p256dh: APPENDIX_A.browserPublic, auth: APPENDIX_A.auth },
      new TextEncoder().encode(APPENDIX_A.plaintext),
      { salt: from(APPENDIX_A.salt), pair: await examplePair() },
    );
    expect(Buffer.from(body).toString('base64url')).toBe(APPENDIX_A.body);
  });

  test('is new for each message: a salt and a key pair of its own', async () => {
    const one = await freshParts();
    const other = await freshParts();
    expect(one.salt).toHaveLength(16);
    expect(Buffer.from(one.salt).equals(Buffer.from(other.salt))).toBe(false);
    const point = async (pair: CryptoKeyPair): Promise<string> =>
      Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('base64url');
    expect(await point(one.pair)).not.toBe(await point(other.pair));
  });
});
