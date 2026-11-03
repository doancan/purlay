/**
 * What the Google definition changes of the OIDC core (`oidc.ts`), with no database: the issuer Google writes
 * into a token with or without its scheme, the bare `sub` as the account, the codes a refusal is said by, and
 * whose say an address is (`authoritativeForGoogle`). The provider is the strict stub at the `fetch` boundary,
 * at an issuer of its own; the whole sign-in through the library is the integration test's.
 */
import { describe, expect, test } from 'bun:test';
import { systemClock } from '../../platform/clock';
import { aRecordingLogger } from '../../testing/doubles';
import {
  anOidcStub,
  OIDC_STUB_CREDENTIALS,
  type OidcBehaviour,
  type OidcPerson,
} from '../../testing/oidc-stub';
import { authoritativeForGoogle, GOOGLE_PROVIDER_ID, googleDefinition } from './google';
import { createOidcProvider, OIDC_DEFINITION, type OidcDefinition } from './oidc';

describe('whose say an address is', () => {
  test.each<[string, unknown, boolean]>([
    ['a@gmail.com', undefined, true],
    ['a@googlemail.com', undefined, true],
    ['Ali@Sirket.COM', 'sirket.com', true],
    ['a@sirket.com', 'Sirket.COM', true],
    ['a@sirket.com', undefined, false],
    ['a@sirket.com', 'other.com', false],
    ['a@sub.sirket.com', 'sirket.com', false],
    ['a@sirket.com', 42, false],
    ['a@sirket.com', ['sirket.com'], false],
    ['a@sirket.com', '', false],
    ['a@notgmail.com', undefined, false],
    ['a@gmail.com.evil.test', undefined, false],
  ])('%s with hd %p is %p', (email, hd, expected) => {
    expect(authoritativeForGoogle(email, hd)).toBe(expected);
  });
});

const ISSUER = 'https://idp.example.test';
const NONCE = 'n'.repeat(32);

/** One `id_token` from the stub, handed to a provider made from `definition`: its identity, or its refusal. */
const verifying = async (
  definition: OidcDefinition | undefined,
  behaviour: OidcBehaviour = {},
  order: string[] = [],
  person: OidcPerson = { sub: '1045', email: 'ada@gmail.com' },
): Promise<{
  readonly outcome: unknown;
  readonly refused: unknown;
  readonly accounts: string[];
  readonly lines: Record<string, unknown>[];
  readonly accountSubject: (sub: string) => unknown;
}> => {
  const stub = await anOidcStub(person, behaviour);
  const { log, lines } = aRecordingLogger();
  const accounts: string[] = [];
  const { provider } = createOidcProvider(
    { issuer: ISSUER, ...OIDC_STUB_CREDENTIALS },
    'Google',
    {
      fetch: stub.fetch,
      clock: systemClock,
      log,
      onIdentity: (key): void => {
        accounts.push(key);
        order.push(`identity ${key}`);
      },
    },
    definition,
  );
  const idToken = await stub.mint(NONCE);
  let outcome: unknown;
  let refused: unknown;
  try {
    outcome = await provider.getUserInfo({ idToken, expectedIdTokenNonce: NONCE });
  } catch (error) {
    refused = error;
  }
  const accountSubject = (sub: string): unknown =>
    provider.accountSubject({ profile: { sub, iss: ISSUER }, account: {} } as never);
  return { outcome, refused, accounts, lines, accountSubject };
};

const admitting: OidcDefinition['admit'] = () => Promise.resolve();

describe('the Google definition', () => {
  test('is the google provider, said by its own codes and log', () => {
    const definition = googleDefinition(ISSUER, admitting);
    expect(GOOGLE_PROVIDER_ID).toBe('google');
    expect(definition).toMatchObject({
      id: 'google',
      acceptedIssuers: [ISSUER, 'idp.example.test'],
      codes: { unavailable: 'GOOGLE_UNAVAILABLE', unverified: 'GOOGLE_EMAIL_UNVERIFIED' },
      logPrefix: 'google sign-in',
    });
    expect(definition.admit).toBe(admitting);
  });

  test('a token whose iss is the issuer without its scheme is Google’s, and no generic provider’s', async () => {
    const bare = { claims: { iss: 'idp.example.test' } };
    const google = await verifying(googleDefinition(ISSUER, admitting), bare);
    expect(google.outcome).toMatchObject({
      user: { email: 'ada@gmail.com', emailVerified: true },
      data: { sub: '1045' },
    });
    const generic = await verifying(OIDC_DEFINITION, bare);
    expect(generic.outcome).toBeNull();
    expect(generic.accounts).toEqual([]);
    // The default is the generic definition, exactly.
    expect((await verifying(undefined, bare)).outcome).toBeNull();
  });

  test('another issuer is refused all the same', async () => {
    const { outcome, accounts } = await verifying(googleDefinition(ISSUER, admitting), {
      claims: { iss: 'https://evil.example.test' },
    });
    expect(outcome).toBeNull();
    expect(accounts).toEqual([]);
  });

  test('the account is the bare sub, with no issuer before it', async () => {
    const { accounts, accountSubject } = await verifying(googleDefinition(ISSUER, admitting));
    expect(accounts).toEqual(['1045']);
    expect(accountSubject('1045')).toBe('1045');
    // The generic provider still keys by issuer.
    expect((await verifying(OIDC_DEFINITION)).accountSubject('1045')).toBe(`${ISSUER}|1045`);
  });

  test('an unverified address is refused by the Google code, in the Google log', async () => {
    const { refused, accounts, lines } = await verifying(googleDefinition(ISSUER, admitting), {
      claims: { email_verified: false },
    });
    expect(refused).toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'GOOGLE_EMAIL_UNVERIFIED' },
    });
    expect(accounts).toEqual([]);
    expect(JSON.stringify(lines)).toContain('google sign-in: ');
    expect(JSON.stringify(lines)).not.toContain('oidc sign-in');
  });

  test('the address is told proven only where it is Google’s; the generic provider’s always is', async () => {
    const outside = { sub: '1045', email: 'ada@sirket.com' };
    const google = googleDefinition(ISSUER, admitting);
    const told = async (
      definition: OidcDefinition | undefined,
      behaviour: OidcBehaviour,
      person: OidcPerson,
    ): Promise<unknown> =>
      ((await verifying(definition, behaviour, [], person)).outcome as { user: unknown }).user;
    expect(await told(google, {}, outside)).toMatchObject({ emailVerified: false });
    expect(await told(google, { claims: { hd: 'sirket.com' } }, outside)).toMatchObject({
      emailVerified: true,
    });
    expect(await told(google, {}, { sub: '1045', email: 'ada@gmail.com' })).toMatchObject({
      emailVerified: true,
    });
    expect(await told(OIDC_DEFINITION, {}, outside)).toMatchObject({ emailVerified: true });
    expect(await told(undefined, {}, outside)).toMatchObject({ emailVerified: true });
  });

  test('a key set that cannot be had is GOOGLE_UNAVAILABLE', async () => {
    const { refused } = await verifying(googleDefinition(ISSUER, admitting), {
      jwks: 'unreachable',
    });
    expect(refused).toMatchObject({ status: 'BAD_GATEWAY', body: { code: 'GOOGLE_UNAVAILABLE' } });
  });

  test('each provider says its refusals as itself, and the generic one’s words are what they always were', async () => {
    const unverified = { claims: { email_verified: false } };
    const unreachable = { jwks: 'unreachable' as const };
    const google = googleDefinition(ISSUER, admitting);
    expect((await verifying(google, unverified)).refused).toMatchObject({
      body: { message: 'Google did not say the address is verified.' },
    });
    expect((await verifying(google, unreachable)).refused).toMatchObject({
      body: { message: 'Google did not answer the sign-in.' },
    });
    // A client of the library's social route reads these as they are: the generic provider's are unchanged.
    expect((await verifying(OIDC_DEFINITION, unverified)).refused).toMatchObject({
      body: {
        code: 'OIDC_EMAIL_UNVERIFIED',
        message: 'The provider did not say the address is verified.',
      },
    });
    expect((await verifying(undefined, unreachable)).refused).toMatchObject({
      body: { code: 'OIDC_UNAVAILABLE', message: 'The single sign-on provider did not answer.' },
    });
  });
});

describe('admission', () => {
  test('is asked with the verified claims, the address and the account, before the account is named', async () => {
    const order: string[] = [];
    const asked: { email: string; accountId: string; hd: unknown }[] = [];
    const definition = googleDefinition(ISSUER, (claims, email, accountId) => {
      asked.push({ email, accountId, hd: claims['hd'] });
      order.push('admit');
      return Promise.resolve();
    });
    await verifying(definition, {}, order, {
      sub: '1045',
      email: 'Ada@Sirket.COM',
      hd: 'sirket.com',
    });
    expect(asked).toEqual([{ email: 'ada@sirket.com', accountId: '1045', hd: 'sirket.com' }]);
    expect(order).toEqual(['admit', 'identity 1045']);
  });

  test('a refusal from it is the sign-in’s, and names nobody', async () => {
    const refusal = new Error('not admitted');
    const { refused, accounts } = await verifying(
      googleDefinition(ISSUER, () => Promise.reject(refusal)),
    );
    expect(refused).toBe(refusal);
    expect(accounts).toEqual([]);
  });

  test('is not asked of a token that is refused, nor of an address that is not verified', async () => {
    let asked = 0;
    const definition = googleDefinition(ISSUER, () => {
      asked += 1;
      return Promise.resolve();
    });
    await verifying(definition, { tamper: 'signed-by-another-key' });
    await verifying(definition, { claims: { email_verified: false } });
    expect(asked).toBe(0);
  });
});
