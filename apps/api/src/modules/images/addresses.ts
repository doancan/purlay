/**
 * The addresses the image proxy may connect to (#110, `docs/spikes/image-proxy.md`): public unicast,
 * and nothing else.
 *
 * - **IPv4**: everything but the special-purpose ranges (RFC 6890 and its updates) — this network,
 *   private, carrier-grade NAT, loopback, link-local (the cloud's metadata service lives there),
 *   protocol assignments, documentation, the 6to4 relay, benchmarking, multicast, reserved, broadcast.
 * - **IPv6**: global unicast (`2000::/3`) only, less the parts of it that are not one host on the
 *   internet — Teredo and the other protocol assignments (`2001::/23`), documentation (`2001:db8::/32`)
 *   and 6to4 (`2002::/16`), which carries an IPv4 address that could be any of the above. Everything
 *   outside `2000::/3` — loopback, unspecified, IPv4-mapped, NAT64, unique local, link-local, multicast
 *   — is refused by that rule alone.
 * - **Parsed strictly**: a form a resolver would never answer (leading zeros, two `::`, a group of five
 *   digits) is not an address, and not a public one.
 */

/** An IPv4 address as a number, or null for anything that is not one in dotted decimal. */
const ipv4 = (text: string): number | null => {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
};

/** An IPv6 address as sixteen bytes, or null. An IPv4 tail (`::ffff:1.2.3.4`) is read as its bytes. */
const ipv6 = (text: string): number[] | null => {
  if (!text.includes(':')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (half: string): number[] | null => {
    if (half === '') return [];
    const pieces = half.split(':');
    const words: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes('.')) {
        const tail = ipv4(piece);
        if (tail === null) return null;
        words.push(Math.floor(tail / 65536), tail % 65536);
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        words.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const head = groupsOf(halves[0] ?? '');
  const tail = halves.length === 2 ? groupsOf(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const words = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0),
    ...tail,
  ];
  return words.flatMap((word) => [Math.floor(word / 256), word % 256]);
};

/** `[first address, prefix length]` of the IPv4 ranges that are not public unicast. */
const IPV4_SPECIAL: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const inIpv4Range = (address: number, [first, bits]: readonly [string, number]): boolean => {
  const start = ipv4(first) ?? 0;
  const size = 2 ** (32 - bits);
  return address >= start && address < start + size;
};

/** Whether the first `bits` bits of the address are the prefix's. */
const hasPrefix = (bytes: readonly number[], prefix: readonly number[], bits: number): boolean => {
  for (let bit = 0; bit < bits; bit += 1) {
    const byte = Math.floor(bit / 8);
    const mask = 0x80 >> (bit % 8);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
};

const IPV6_NOT_HOSTS: readonly (readonly [readonly number[], number])[] = [
  [[0x20, 0x01, 0x00, 0x00], 23],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x20, 0x02], 16],
  // Documentation, RFC 9637.
  [[0x3f, 0xff, 0x00], 20],
];

export const isPublicAddress = (address: string): boolean => {
  const v4 = ipv4(address);
  if (v4 !== null) return !IPV4_SPECIAL.some((range) => inIpv4Range(v4, range));
  const v6 = ipv6(address);
  if (v6 === null) return false;
  if (!hasPrefix(v6, [0x20], 3)) return false;
  return !IPV6_NOT_HOSTS.some(([prefix, bits]) => hasPrefix(v6, prefix, bits));
};
