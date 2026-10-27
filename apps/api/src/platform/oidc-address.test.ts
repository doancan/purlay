/**
 * The one rule for a provider's issuer and a button's label (D-200 §2, §7): what the configuration, the
 * settings and the probe all ask.
 */
import { describe, expect, test } from 'bun:test';
import {
  isFetchableAddress,
  oidcDiscoveryAddress,
  oidcIssuerProblem,
  oidcNameProblem,
} from './oidc-address';

describe('an issuer', () => {
  test.each([
    'https://login.example.com',
    'https://login.example.com/',
    'https://login.example.com/tenant-1/v2.0',
    'https://login.example.com:8443/realms/purlay',
    'http://localhost:9000',
    'http://127.0.0.1:9000/realm',
    'http://[::1]:9000',
  ])('%s is one this server will sign in through', (issuer) => {
    expect(oidcIssuerProblem(issuer)).toBeUndefined();
  });

  test.each([
    ['', 'not an absolute address'],
    ['login.example.com', 'not an absolute address'],
    ['//login.example.com', 'not an absolute address'],
    ['http://login.example.com', 'must be https://, or http:// to this machine'],
    ['http://192.168.1.10', 'must be https://, or http:// to this machine'],
    ['ftp://login.example.com', 'must be https://, or http:// to this machine'],
    ['javascript:alert(1)', 'must be https://, or http:// to this machine'],
    ['https://u:p@login.example.com', 'an address without credentials, query or fragment'],
    ['https://login.example.com/?tenant=1', 'an address without credentials, query or fragment'],
    ['https://login.example.com/#x', 'an address without credentials, query or fragment'],
    // Empty to the URL parser, and still not the issuer a provider puts in a token.
    ['https://login.example.com/?', 'an address without credentials, query or fragment'],
    ['https://login.example.com/#', 'an address without credentials, query or fragment'],
  ])('%j is refused: %s', (issuer, problem) => {
    expect(oidcIssuerProblem(issuer)).toBe(problem);
  });

  test('the reason never quotes the value', () => {
    expect(oidcIssuerProblem('https://user:hunter2@login.example.com')).not.toContain('hunter2');
  });

  test('an address a provider’s endpoint may be fetched from is https, or http to this machine', () => {
    expect(isFetchableAddress(new URL('https://idp.example.com/jwks'))).toBe(true);
    expect(isFetchableAddress(new URL('http://127.0.0.1:1/jwks'))).toBe(true);
    expect(isFetchableAddress(new URL('http://idp.example.com/jwks'))).toBe(false);
    expect(isFetchableAddress(new URL('file:///etc/passwd'))).toBe(false);
  });

  test('discovery is asked for at the issuer’s well-known address, trailing slashes dropped, path kept', () => {
    expect(oidcDiscoveryAddress('https://login.example.com')).toBe(
      'https://login.example.com/.well-known/openid-configuration',
    );
    expect(oidcDiscoveryAddress('https://login.example.com/')).toBe(
      'https://login.example.com/.well-known/openid-configuration',
    );
    expect(oidcDiscoveryAddress('https://login.example.com/tenant-1//')).toBe(
      'https://login.example.com/tenant-1/.well-known/openid-configuration',
    );
  });
});

describe('a button’s label', () => {
  test.each(['Acme SSO', 'Okta', 'Şirket girişi', '会社のログイン', 'Acme 🔐', 'a'])(
    '%s is a name',
    (name) => {
      expect(oidcNameProblem(name, 40)).toBeUndefined();
    },
  );

  test.each([
    ['', 'a name with no space around it'],
    [' Acme', 'a name with no space around it'],
    ['Acme ', 'a name with no space around it'],
    ['Ac\u0000me', 'a name of visible characters'],
    ['Ac\nme', 'a name of visible characters'],
    ['Acme‮', 'a name of visible characters'],
    ['Ac​me', 'a name of visible characters'],
    ['Ac me', 'a name of visible characters'],
    ['x'.repeat(41), 'at most 40 characters'],
  ])('%j is refused: %s', (name, problem) => {
    expect(oidcNameProblem(name, 40)).toBe(problem);
  });

  test('the limit is in characters, not in bytes or UTF-16 units', () => {
    expect(oidcNameProblem('🔐'.repeat(40), 40)).toBeUndefined();
    expect(oidcNameProblem('🔐'.repeat(41), 40)).toBe('at most 40 characters');
  });
});
