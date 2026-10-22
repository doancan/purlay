/**
 * What spending a link would do to an account whose address was never proven, stopped inside the
 * sign-in library (D-179 §4, Ruling R32). Better Auth 1.7.12, measured: it removes every account linked
 * to it — the password among them — ends its sessions and marks the address verified. Purlay refuses
 * such a link before the library is asked (`magic-link.integration.test.ts`); these ask the library
 * directly, past that check, and show its spend undone whole.
 *
 * On a cloned database, because the undoing is the spend's own transaction, which a test's rolled-back
 * transaction cannot hold (D-46).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { aRecordingOutbox, testDependencies } from '../../testing/doubles';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

/**
 * A link to a new address, and then an account at it whose address was never proven: the setup
 * administrator's shape (a password, and a GitHub link to show every account is kept), or none.
 */
const anUnprovenAccount = async (
  withAccounts: boolean,
): Promise<{
  readonly userId: string;
  readonly email: string;
  readonly spend: () => Promise<unknown>;
}> => {
  const mail = aRecordingOutbox();
  const links = testDependencies({ database: cloned.db, mail, signUp: 'open' }).auth.signInLinks;
  if (links === undefined) throw new Error('sign-in by link is not on');
  const email = `unproven-${crypto.randomUUID().slice(0, 8)}@example.test`;
  await links.issue(email, { locale: 'en' });
  const token = /#([0-9a-f]{64})/.exec(mail.posted[0]?.text ?? '')?.[1] ?? '';
  const { id } = await cloned.db
    .insertInto('users')
    .values({
      email,
      username: email.slice(0, email.indexOf('@')),
      display_name: 'Admin',
      email_verified: false,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (withAccounts) {
    await cloned.db
      .insertInto('accounts')
      .values([
        { user_id: id, account_id: id, provider_id: 'credential', password: 'a-password-hash' },
        { user_id: id, account_id: '4242', provider_id: 'github' },
      ])
      .execute();
  }
  await cloned.db
    .insertInto('sessions')
    .values({
      user_id: id,
      token_hash: `before-${id}`,
      expires_at: new Date(Date.now() + 60 * 60_000),
    })
    .execute();
  return { userId: id, email, spend: async () => await links.spend(token, new Headers()) };
};

const whatIsLeft = async (userId: string): Promise<unknown> => ({
  verified: (
    await cloned.db
      .selectFrom('users')
      .select('email_verified')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
  ).email_verified,
  accounts: (
    await cloned.db
      .selectFrom('accounts')
      .select(['provider_id', 'password'])
      .where('user_id', '=', userId)
      .orderBy('provider_id')
      .execute()
  ).map((row) => [row.provider_id, row.password]),
  sessions: (
    await cloned.db
      .selectFrom('sessions')
      .select('token_hash')
      .where('user_id', '=', userId)
      .execute()
  ).map((row) => row.token_hash),
});

describe('integration: a link spent past every check, on an account never proven', () => {
  test('the password, the GitHub link and the session survive, and nobody is signed in', async () => {
    const { userId, email, spend } = await anUnprovenAccount(true);
    expect(await spend()).toBeUndefined();
    // Refused, the link is left as it was: the spend's transaction took its delete back too.
    expect(
      await cloned.db
        .selectFrom('verifications')
        .select('id')
        .where('value', 'like', `%${email}%`)
        .execute(),
    ).toHaveLength(1);
    expect(await whatIsLeft(userId)).toEqual({
      verified: false,
      accounts: [
        ['credential', 'a-password-hash'],
        ['github', null],
      ],
      sessions: [`before-${userId}`],
    });
  });

  test('with no account linked, its sessions survive and the address stays unproven', async () => {
    const { userId, spend } = await anUnprovenAccount(false);
    expect(await spend()).toBeUndefined();
    expect(await whatIsLeft(userId)).toEqual({
      verified: false,
      accounts: [],
      sessions: [`before-${userId}`],
    });
  });
});
