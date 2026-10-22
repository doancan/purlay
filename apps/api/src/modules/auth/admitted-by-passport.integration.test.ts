/**
 * `admittedByPassport` fails closed (R51): on an invite-only server, any account creation made for a
 * request that is not one of the two paths a passport admits is refused, so a route or provider added
 * later cannot silently open a closed server. Creation outside any request (the setup's administrator)
 * is not decided here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { admittedByPassport } from './better-auth';
import { aMovableClock } from '../../testing/doubles';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

const deps = (): Parameters<typeof admittedByPassport>[0] => ({
  database: cloned.db,
  clock: aMovableClock(),
});

/** What the hook threw, or `undefined` when it let the creation through. */
const thrownBy = async (
  context: Parameters<typeof admittedByPassport>[2],
): Promise<{ readonly body?: { readonly code?: string } } | undefined> => {
  try {
    await admittedByPassport(deps(), 'someone@example.test', context);
    return undefined;
  } catch (error) {
    return error as { readonly body?: { readonly code?: string } };
  }
};

describe('integration: admittedByPassport', () => {
  test.each(['/sign-in/email-otp', '/sign-in/social', '/admin/create-user', '/oauth2/callback'])(
    'refuses a creation made for %s, a path no passport admits',
    async (path) => {
      expect((await thrownBy({ path, headers: new Headers() }))?.body?.code).toBe(
        'signup_disabled',
      );
    },
  );

  test('refuses a request whose route is unknown', async () => {
    expect((await thrownBy({ headers: new Headers() }))?.body?.code).toBe('signup_disabled');
  });

  test('leaves a creation outside any request to its caller', async () => {
    // The library hands a hook `undefined` (or null) for a creation made outside a request.
    expect(await thrownBy(undefined)).toBeUndefined();
    expect(await thrownBy(null)).toBeUndefined();
  });
});
