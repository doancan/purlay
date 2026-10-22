/**
 * Who a request is from, for a limit and for a session's record.
 *
 * `X-Forwarded-For` is written by the client until a proxy we trust rewrites it,
 * so what these pin is what is *not* believed (#235).
 */
import { describe, expect, test } from 'bun:test';
import { limitKeyFor } from '../../platform/client-key';
import { clientAddress } from './client-address';

const forwarded = (value: string): Headers => new Headers({ 'x-forwarded-for': value });

describe('the client address', () => {
  test('without a trusted proxy the socket peer is the client, and the header is ignored', () => {
    expect(clientAddress('203.0.113.9', forwarded('198.51.100.1'), false)).toBe('203.0.113.9');
    expect(clientAddress('203.0.113.9', forwarded('198.51.100.1, 192.0.2.7'), false)).toBe(
      '203.0.113.9',
    );
  });

  /** The spoof: rotate the header per request to get a fresh budget each time. */
  test('a spoofed header cannot change who we think the client is', () => {
    const seen = new Set(
      ['1.1.1.1', '2.2.2.2', '3.3.3.3'].map((spoof) =>
        clientAddress('203.0.113.9', forwarded(spoof), false),
      ),
    );
    expect([...seen]).toEqual(['203.0.113.9']);
  });

  test('behind a trusted proxy the address it appended is the client: the last, not the first', () => {
    // The client wrote the first entries; the proxy wrote the last.
    expect(clientAddress('10.0.0.2', forwarded('6.6.6.6, 198.51.100.1'), true)).toBe(
      '198.51.100.1',
    );
    expect(clientAddress('10.0.0.2', forwarded('198.51.100.1'), true)).toBe('198.51.100.1');
  });

  test('a trusted proxy that sent nothing usable falls back to the peer, not to the header', () => {
    expect(clientAddress('10.0.0.2', new Headers(), true)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', forwarded('not-an-address'), true)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', forwarded(''), true)).toBe('10.0.0.2');
    expect(clientAddress('10.0.0.2', forwarded('1.1.1.1, <script>'), true)).toBe('10.0.0.2');
  });

  test('an IPv4-mapped IPv6 peer is the IPv4 address', () => {
    expect(clientAddress('::ffff:203.0.113.9', new Headers(), false)).toBe('203.0.113.9');
  });

  test('no peer and no trusted header is no address, never a guess', () => {
    expect(clientAddress(undefined, forwarded('1.1.1.1'), false)).toBeUndefined();
  });

  test('what comes back is always an address the database column will accept', () => {
    for (const value of ['203.0.113.9', '2001:db8::1', '::1']) {
      expect(clientAddress(value, new Headers(), false)).toBe(value);
    }
    expect(clientAddress('999.1.1.1', new Headers(), false)).toBeUndefined();
  });
});

describe('the key a limit is held under', () => {
  test('an IPv4 address is its own key', () => {
    expect(limitKeyFor('203.0.113.9')).toBe('203.0.113.9');
  });

  /** A single subscriber holds a /64: per-address buckets would be unlimited. */
  test('every address in one IPv6 /64 shares a key; another /64 does not', () => {
    const a = limitKeyFor('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(limitKeyFor('2001:db8:1:2::1')).toBe(a);
    expect(limitKeyFor('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(limitKeyFor('2001:db8:1:3::1')).not.toBe(a);
  });

  test('compressed and expanded spellings of one address are one key', () => {
    expect(limitKeyFor('2001:db8::1')).toBe(limitKeyFor('2001:0db8:0000:0000:0000:0000:0000:0001'));
  });

  test('an unknown address shares one bucket: the safe failure is a stricter limit', () => {
    expect(limitKeyFor(undefined)).toBe('unknown');
    expect(limitKeyFor('not an address')).toBe('unknown');
  });

  test('an IPv4 address mapped into IPv6 is the IPv4 address’s key', () => {
    expect(limitKeyFor('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });
});
