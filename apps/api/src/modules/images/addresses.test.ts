/**
 * Which addresses the image proxy may connect to (#110, `docs/spikes/image-proxy.md`): public unicast
 * and nothing else — every private, local, shared, reserved and documentation range refused, in both
 * families and in the IPv6 forms that carry an IPv4 address inside them.
 */
import { describe, expect, test } from 'bun:test';
import { isPublicAddress } from './addresses';

describe('a public address', () => {
  test.each([
    ['8.8.8.8'],
    ['140.82.112.3'],
    ['185.199.108.133'],
    ['1.1.1.1'],
    ['2606:4700:4700::1111'],
    ['2a00:1450:4001:82a::200e'],
  ])('%s is one', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  test.each([
    ['0.0.0.0', 'this network'],
    ['0.255.255.255', 'this network'],
    ['10.0.0.1', 'private'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['100.127.255.255', 'carrier-grade NAT'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['169.254.169.254', 'link-local — the cloud metadata address'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.0.0.8', 'IETF protocol assignments'],
    ['192.0.2.1', 'documentation'],
    ['192.88.99.1', '6to4 relay'],
    ['192.168.1.1', 'private'],
    ['198.18.0.1', 'benchmarking'],
    ['198.19.255.255', 'benchmarking'],
    ['198.51.100.1', 'documentation'],
    ['203.0.113.1', 'documentation'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.250', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex'],
    ['::ffff:10.0.0.1', 'IPv4-mapped private'],
    ['64:ff9b::a00:1', 'NAT64 of a private address'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['3fff::1', 'documentation, RFC 9637'],
    ['2001::1', 'Teredo'],
    ['2002:a00:1::1', '6to4, which carries 10.0.0.1'],
    ['100::1', 'discard'],
  ])('%s is not (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  test('just inside and just outside a range’s edges', () => {
    expect(isPublicAddress('172.15.255.255')).toBe(true);
    expect(isPublicAddress('172.32.0.0')).toBe(true);
    expect(isPublicAddress('100.63.255.255')).toBe(true);
    expect(isPublicAddress('100.128.0.0')).toBe(true);
    expect(isPublicAddress('198.17.255.255')).toBe(true);
    expect(isPublicAddress('198.20.0.0')).toBe(true);
    expect(isPublicAddress('223.255.255.255')).toBe(true);
  });

  test('what is not an address at all is not a public one', () => {
    for (const nonsense of [
      '',
      'example.com',
      '256.1.1.1',
      '1.2.3',
      '::g',
      '1::2::3',
      '01.2.3.4',
    ]) {
      expect(isPublicAddress(nonsense)).toBe(false);
    }
  });
});
