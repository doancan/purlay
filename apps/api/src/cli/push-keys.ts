/**
 * Prints a Web Push key pair for the configuration (#78, D-126):
 *
 *   bun run push:keys
 *
 * Keep the private one with the other secrets. Replacing the pair later is allowed: a device
 * subscribed with the old one is made again with the new one the next time its person opens Purlay.
 *
 * Through WebCrypto's JWK, whose scalar is always the full 32 bytes: `node:crypto`'s ECDH drops a
 * leading zero byte, about one key in two hundred, and the configuration refuses that shorter key.
 */
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
]);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
if (d === undefined) throw new Error('a generated P-256 key exported without its scalar');
console.log(`VAPID_PUBLIC_KEY=${publicKey.toString('base64url')}\nVAPID_PRIVATE_KEY=${d}`);
