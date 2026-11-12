import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { OIDC_CLIENT_SECRET_MAX, OIDC_CLIENT_ID_MAX, OIDC_ISSUER_MAX, OIDC_NAME_MAX } from './api';
import {
  CompanyIdentityConnection,
  CreateCompanyConnectionRequest,
  CreateCompanyDomainRequest,
  SetCompanyConnectionEnabledRequest,
  StartCompanyIdentityRequest,
  UnlinkCompanyIdentityRequest,
  UpdateCompanyConnectionRequest,
  normalisedCompanyDomain,
} from './workspace-identity';

const configuration = (): CreateCompanyConnectionRequest => ({
  name: 'Company account',
  domainId: crypto.randomUUID(),
  issuer: 'https://accounts.example.test',
  clientId: 'company-client',
  clientSecret: 'write-only-secret',
});

describe('workspace company identity contracts', () => {
  test('creation requires an explicit domain and a write-only secret', () => {
    expect(Value.Check(CreateCompanyConnectionRequest, configuration())).toBe(true);
    const withoutSecret = { ...configuration() };
    Reflect.deleteProperty(withoutSecret, 'clientSecret');
    expect(Value.Check(CreateCompanyConnectionRequest, withoutSecret)).toBe(false);
    const withoutDomain = { ...configuration() };
    Reflect.deleteProperty(withoutDomain, 'domainId');
    expect(Value.Check(CreateCompanyConnectionRequest, withoutDomain)).toBe(false);
    expect(Object.keys(CompanyIdentityConnection.properties)).not.toContain('clientSecret');
    expect(Object.keys(CompanyIdentityConnection.properties)).not.toContain('clientSecretSealed');
  });

  test('a client cannot attach another tenant, enable an untested connection or supply a user mapping', () => {
    for (const extra of [
      { workspaceId: crypto.randomUUID() },
      { enabled: true },
      { testedAt: '2026-11-12T00:00:00Z' },
      { userId: crypto.randomUUID() },
      { subject: 'chosen-by-client' },
      { role: 'owner' },
    ])
      expect(Value.Check(CreateCompanyConnectionRequest, { ...configuration(), ...extra })).toBe(
        false,
      );
  });

  test('existing OIDC field bounds also apply to company connections', () => {
    for (const [key, maximum] of [
      ['name', OIDC_NAME_MAX],
      ['issuer', OIDC_ISSUER_MAX],
      ['clientId', OIDC_CLIENT_ID_MAX],
      ['clientSecret', OIDC_CLIENT_SECRET_MAX],
    ] as const) {
      expect(Value.Check(CreateCompanyConnectionRequest, { ...configuration(), [key]: '' })).toBe(
        false,
      );
      expect(
        Value.Check(CreateCompanyConnectionRequest, {
          ...configuration(),
          [key]: 'a'.repeat(maximum),
        }),
      ).toBe(true);
      expect(
        Value.Check(CreateCompanyConnectionRequest, {
          ...configuration(),
          [key]: 'a'.repeat(maximum + 1),
        }),
      ).toBe(false);
    }
  });

  test('an edit names its observed revision and contains a change; an omitted secret is retained', () => {
    const revision = crypto.randomUUID();
    expect(
      Value.Check(UpdateCompanyConnectionRequest, { revision, name: 'Google Workspace' }),
    ).toBe(true);
    expect(
      Value.Check(UpdateCompanyConnectionRequest, { revision, clientSecret: 'replacement' }),
    ).toBe(true);
    for (const input of [
      {},
      { revision },
      { name: 'Unfenced' },
      { revision: 'bad', name: 'Company' },
      { revision, clientSecret: '' },
      { revision, clientSecret: null },
      { revision, enabled: true },
      { revision, userId: crypto.randomUUID() },
    ])
      expect(Value.Check(UpdateCompanyConnectionRequest, input)).toBe(false);
  });

  test('enable and identity flows have separate bounded capabilities', () => {
    const revision = crypto.randomUUID();
    expect(Value.Check(SetCompanyConnectionEnabledRequest, { revision, enabled: false })).toBe(
      true,
    );
    expect(Value.Check(SetCompanyConnectionEnabledRequest, { enabled: true })).toBe(false);
    expect(Value.Check(SetCompanyConnectionEnabledRequest, { revision, enabled: 'true' })).toBe(
      false,
    );
    for (const intent of ['link', 'test'])
      expect(Value.Check(StartCompanyIdentityRequest, { revision, intent })).toBe(true);
    for (const input of [
      { revision, intent: 'login' },
      { revision, intent: 'link', userId: crypto.randomUUID() },
      { revision, intent: 'test', callbackURL: 'https://attacker.example' },
      { revision, intent: 'link', subject: 'client-subject' },
    ])
      expect(Value.Check(StartCompanyIdentityRequest, input)).toBe(false);
  });

  test('unlink names the observed binding so an older request cannot remove its replacement', () => {
    expect(Value.Check(UnlinkCompanyIdentityRequest, { bindingId: crypto.randomUUID() })).toBe(
      true,
    );
    for (const input of [
      {},
      { userId: crypto.randomUUID() },
      { bindingId: 'bad' },
      { bindingId: crypto.randomUUID(), subject: 'another' },
    ])
      expect(Value.Check(UnlinkCompanyIdentityRequest, input)).toBe(false);
  });

  test('domain proof cannot be asserted by a client', () => {
    expect(Value.Check(CreateCompanyDomainRequest, { domain: 'example.com' })).toBe(true);
    expect(Value.Check(CreateCompanyDomainRequest, { domain: 'example.com', verified: true })).toBe(
      false,
    );
    expect(
      Value.Check(CreateCompanyDomainRequest, { domain: 'example.com', challenge: 'chosen' }),
    ).toBe(false);
    expect(Value.Check(CreateCompanyDomainRequest, { domain: 'a'.repeat(254) })).toBe(false);
  });

  test('domain names have one canonical DNS identity, including international company names', () => {
    expect(normalisedCompanyDomain(' EXAMPLE.com. ')).toBe('example.com');
    expect(normalisedCompanyDomain('bücher.example')).toBe('xn--bcher-kva.example');
    expect(normalisedCompanyDomain('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    expect(normalisedCompanyDomain('company.internal')).toBe('company.internal');
    expect(normalisedCompanyDomain('a'.repeat(63) + '.example')).toBe('a'.repeat(63) + '.example');
  });

  test('a domain is neither a URL, address, IP, wildcard, control string nor an unbounded DNS name', () => {
    for (const input of [
      '',
      'localhost',
      '*.example.com',
      'name@example.com',
      'https://example.com',
      'example.com:443',
      'example.com/path',
      'example.com?query',
      'example.com#fragment',
      'example.com\\evil',
      '127.0.0.1',
      '0x7f000001',
      '[::1]',
      'example..com',
      '-bad.example',
      'bad-.example',
      '.example.com',
      'example.com..',
      'a_b.example',
      'exa mple.com',
      'example\n.com',
      'examp\u200ble.com',
      'a'.repeat(64) + '.example',
      Array.from({ length: 5 }, () => 'a'.repeat(63)).join('.'),
    ])
      expect(normalisedCompanyDomain(input)).toBeUndefined();
  });
});
