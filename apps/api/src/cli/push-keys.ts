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
import { generateVapidKeys } from '../modules/push/vapid';

const { publicKey, privateKey } = await generateVapidKeys('https://purlay.app');
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
