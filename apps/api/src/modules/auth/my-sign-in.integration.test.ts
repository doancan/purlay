/**
 * How an account signs in, read for its owner (D-176, D-179 §5): the address, whether a link to it
 * signs in, whether it has a password, and its GitHub account — and nothing at all for an account
 * that is erased or does not exist.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { mySignIn } from './my-sign-in';

afterAll(async () => {
  await closeIntegrationDatabase();
});

type Database = Parameters<Parameters<typeof withRollback>[0]>[0];

interface Shape {
  readonly githubId?: string;
  readonly githubLogin?: string;
  readonly connected?: boolean;
  readonly password?: boolean;
  readonly deleted?: boolean;
}

const made = async (db: Database, shape: Shape = {}): Promise<string> => {
  const tag = crypto.randomUUID().slice(0, 8);
  const user = await db
    .insertInto('users')
    .values({
      email: `person-${tag}@example.test`,
      username: `person-${tag}`,
      display_name: 'Person',
      github_id: shape.githubId ?? null,
      github_login: shape.githubLogin ?? null,
      github_connected_at: shape.connected === true ? new Date('2026-09-09T12:00:00Z') : null,
      deleted_at: shape.deleted === true ? new Date('2026-09-09T12:00:00Z') : null,
    })
    .returning(['id', 'email'])
    .executeTakeFirstOrThrow();
  if (shape.password === true) {
    await db
      .insertInto('accounts')
      .values({
        user_id: user.id,
        account_id: user.id,
        provider_id: 'credential',
        password: 'a-hash-the-library-made',
      })
      .execute();
  }
  return user.id;
};

/** Neither rule of the sign-in policy on (D-239). */
const NO_POLICY = { requireTwoFactor: false, passwordSignIn: true } as const;

const refusal = async (promise: Promise<unknown>): Promise<string> =>
  await promise.then(
    () => 'answered',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );

describe('integration: how an account signs in', () => {
  test('an account made by email has links and, with a credential, a password; no GitHub', async () => {
    await withRollback(async (db) => {
      const without = await made(db);
      const withPassword = await made(db, { password: true });
      expect(await mySignIn(db, without, NO_POLICY)).toMatchObject({
        emailLinks: true,
        hasPassword: false,
        github: null,
        oidc: false,
        twoFactor: false,
      });
      expect(await mySignIn(db, withPassword, NO_POLICY)).toMatchObject({
        emailLinks: true,
        hasPassword: true,
        github: null,
        oidc: false,
        twoFactor: false,
      });
    });
  });

  test('an account GitHub made has no link by email, and names its GitHub login', async () => {
    await withRollback(async (db) => {
      const id = await made(db, { githubId: '5001', githubLogin: 'octocat' });
      expect(await mySignIn(db, id, NO_POLICY)).toEqual({
        email: expect.stringContaining('@example.test') as string,
        emailLinks: false,
        hasPassword: false,
        github: { login: 'octocat' },
        oidc: false,
        twoFactor: false,
        twoFactorRequired: false,
      });
    });
  });

  test('an email account linked to GitHub keeps its links', async () => {
    await withRollback(async (db) => {
      const id = await made(db, { githubId: '5002', githubLogin: 'linked', connected: true });
      expect(await mySignIn(db, id, NO_POLICY)).toMatchObject({
        emailLinks: true,
        github: { login: 'linked' },
      });
    });
  });

  test('single sign-on is named only for the account it is linked to, and never for anybody else’s', async () => {
    await withRollback(async (db) => {
      const linked = await made(db);
      const other = await made(db);
      await db
        .insertInto('accounts')
        .values({
          user_id: linked,
          account_id: 'https://idp.example.test|sub-1',
          provider_id: 'oidc',
        })
        .execute();
      expect(await mySignIn(db, linked, NO_POLICY)).toMatchObject({ oidc: true });
      expect(await mySignIn(db, other, NO_POLICY)).toMatchObject({ oidc: false });
    });
  });

  test('two-step verification is required of an account with a password, only where the policy asks and passwords sign in (D-239)', async () => {
    await withRollback(async (db) => {
      const withPassword = await made(db, { password: true });
      const without = await made(db);
      const required = { requireTwoFactor: true, passwordSignIn: true };
      expect(await mySignIn(db, withPassword, required)).toMatchObject({ twoFactorRequired: true });
      expect(await mySignIn(db, without, required)).toMatchObject({ twoFactorRequired: false });
      expect(await mySignIn(db, withPassword, NO_POLICY)).toMatchObject({
        twoFactorRequired: false,
      });
      // Passwords off: the password is no way in, so nothing is required of it.
      expect(
        await mySignIn(db, withPassword, { requireTwoFactor: true, passwordSignIn: false }),
      ).toMatchObject({ twoFactorRequired: false });
    });
  });

  test('an erased account and an unknown one are both not signed in', async () => {
    await withRollback(async (db) => {
      const erased = await made(db, { deleted: true });
      expect(await refusal(mySignIn(db, erased, NO_POLICY))).toBe('UNAUTHENTICATED');
      expect(await refusal(mySignIn(db, crypto.randomUUID(), NO_POLICY))).toBe('UNAUTHENTICATED');
    });
  });
});
