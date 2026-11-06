import { describe, expect, test } from 'bun:test';
import { relayAddress } from './smtp-fields';
const basic = { host: 'mail.example.test', port: '587', tls: false, username: '', password: '' };
describe('structured SMTP address', () => {
  test('encodes credentials and preserves literal punctuation without changing the host', () => {
    const value = relayAddress({ ...basic, username: 'me@example.test', password: 'x:@/?#&' });
    expect(value).not.toBeNull();
    const url = new URL(value ?? '');
    expect(url.hostname).toBe('mail.example.test');
    expect(decodeURIComponent(url.username)).toBe('me@example.test');
    expect(decodeURIComponent(url.password)).toBe('x:@/?#&');
  });
  test('anonymous, implicit TLS and bracketed IPv6 are representable', () => {
    expect(relayAddress(basic)).toBe('smtp://mail.example.test:587');
    expect(relayAddress({ ...basic, tls: true, port: '465' })).toBe(
      'smtps://mail.example.test:465',
    );
    expect(relayAddress({ ...basic, host: '[::1]' })).toBe('smtp://[::1]:587');
  });
  test('a host cannot smuggle credentials, port, URL, path, query or fragment', () => {
    for (const host of [
      'smtp://mail.test',
      'me@mail.test',
      'mail.test:2525',
      'mail.test/a',
      'mail.test?x',
      'mail.test#x',
      'mail test',
      '',
    ])
      expect(relayAddress({ ...basic, host })).toBeNull();
    for (const port of ['0', '65536', '1.5', ' 587', '1e3', ''])
      expect(relayAddress({ ...basic, port })).toBeNull();
  });
});
