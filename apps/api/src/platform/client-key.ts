/**
 * The key a client's limit is held under (D-138 §7, D-179 §4): one home for every budget kept per
 * client — the edge's (`ingress/http/rate-limit.ts`), the sign-in links' and the wrong passwords'
 * (`modules/auth/password-attempts.ts`).
 */
import { isIP } from 'node:net';

/** `::ffff:203.0.113.9` is the IPv4 address `203.0.113.9` as a dual-stack socket reports it. */
export const unmappedAddress = (address: string): string => {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped?.[1] ?? address;
};

/** Expands `::` so the first four groups can be read off. Input is a valid IPv6 address. */
const hextets = (address: string): string[] => {
  const [head = '', tail] = address.split('::');
  const front = head === '' ? [] : head.split(':');
  const back = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill('0');
  return [...front, ...fill, ...back].map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''));
};

/**
 * The key a limit is held under. An IPv6 subscriber is given a whole /64, so a
 * budget per address would be a budget per request; every address in one /64
 * shares a key. An IPv4 address mapped into IPv6 is the IPv4 address. No address
 * at all — or something that is not one — shares one bucket: a stricter limit is
 * the safe way for this to fail.
 */
export const limitKeyFor = (address: string | undefined): string => {
  if (address === undefined) return 'unknown';
  const plain = unmappedAddress(address.trim());
  const family = isIP(plain);
  if (family === 4) return plain;
  if (family === 0) return 'unknown';
  return `${hextets(plain).slice(0, 4).join(':')}::/64`;
};
