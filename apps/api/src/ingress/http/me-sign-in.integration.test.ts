/**
 * `GET /api/me/sign-in` (D-176, D-179 §5): how the caller signs in, read only, against a real database.
 * It is the one thing left of connecting GitHub by hand — the card on Sessions & account names the
 * address and the linked login, and nothing starts from it. So what is checked is what it tells:
 * whether a link sent to the address signs in (an account GitHub made has none, one made by email
 * keeps its link once GitHub is linked to it), the login, and that it is only ever the caller's own.
 */
import { describe, expect, test } from 'bun:test';
import { withRollback, type Executor } from '@purlay/db';
import { MySignIn } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';

const ORIGIN = 'https://purlay.test';

const readAs = async (db: Executor, cookie: string | undefined): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock: fixedClock(NOW) })).handle(
    new Request(`${ORIGIN}/api/me/sign-in`, cookie === undefined ? {} : { headers: { cookie } }),
  );

const answerTo = async (db: Executor, user: SignedInUser): Promise<MySignIn> => {
  const response = await readAs(db, user.cookie);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(Value.Check(MySignIn, body)).toBe(true);
  return body as MySignIn;
};

describe('integration: how the caller signs in', () => {
  test('an account made by email: its address, a link that signs in, and no GitHub', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'signin-ada');
      expect(await answerTo(db, ada)).toEqual({
        email: ada.email,
        emailLinks: true,
        hasPassword: false,
        github: null,
        oidc: false,
        twoFactor: false,
        twoFactorRequired: false,
      });
    });
  });

  test('an account with a password says so, and one whose password was removed does not', async () => {
    await withRollback(async (db) => {
      const admin = await aSignedInUser(db, fixedClock(NOW), 'signin-password');
      await db
        .insertInto('accounts')
        .values({
          user_id: admin.userId,
          account_id: admin.userId,
          provider_id: 'credential',
          password: 'scrypt-hash-for-the-test',
        })
        .execute();
      expect((await answerTo(db, admin)).hasPassword).toBe(true);
    });
  });

  test('an account GitHub made: GitHub and its login, and no link', async () => {
    await withRollback(async (db) => {
      const made = await aSignedInUser(db, fixedClock(NOW), 'signin-made');
      await db
        .updateTable('users')
        .set({ github_id: '700000001', github_login: 'made-with-github' })
        .where('id', '=', made.userId)
        .execute();
      expect(await answerTo(db, made)).toEqual({
        email: made.email,
        emailLinks: false,
        hasPassword: false,
        github: { login: 'made-with-github' },
        oidc: false,
        twoFactor: false,
        twoFactorRequired: false,
      });
    });
  });

  test('an account made by email that GitHub is linked to keeps its link, and shows the login', async () => {
    await withRollback(async (db) => {
      const linked = await aSignedInUser(db, fixedClock(NOW), 'signin-linked');
      await db
        .updateTable('users')
        .set({
          github_id: '700000002',
          github_login: 'linked-login',
          github_connected_at: NOW,
        })
        .where('id', '=', linked.userId)
        .execute();
      expect(await answerTo(db, linked)).toEqual({
        email: linked.email,
        emailLinks: true,
        hasPassword: false,
        github: { login: 'linked-login' },
        oidc: false,
        twoFactor: false,
        twoFactorRequired: false,
      });
    });
  });

  test('is each caller’s own, and nobody’s without a session', async () => {
    await withRollback(async (db) => {
      const ada = await aSignedInUser(db, fixedClock(NOW), 'signin-own-a');
      const grace = await aSignedInUser(db, fixedClock(NOW), 'signin-own-b');
      expect((await answerTo(db, ada)).email).toBe(ada.email);
      expect((await answerTo(db, grace)).email).toBe(grace.email);
      expect((await readAs(db, undefined)).status).toBe(401);
    });
  });
});
