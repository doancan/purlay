/**
 * `bun run admin:reset-password` (D-179 §4): the command run as a process against a database of the
 * test's own — never the one `DATABASE_URL` names for the developer — with the password on standard
 * input. Held here: the row it writes signs in through the real library, every session of the account
 * ends in the same transaction, only the server's administrator is changed, the policy applies, and a
 * password given as an argument or in the environment is neither accepted nor repeated.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type Executor,
  DROP_HOOK_MS,
} from '@purlay/db';
import { hashPassword } from 'better-auth/crypto';
import { signInAdmin } from '../modules/setup/admin';
import { systemClock } from '../platform/clock';
import { aSession, aTestAuth } from '../testing/signed-in';
import { aUserRow } from '../testing/users';

const SCRIPT = `${import.meta.dir}/admin-reset-password.ts`;
const OLD = 'the old password 2026';
const NEW = 'recovered on the server 7';

const clones: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

interface Ran {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

const run = (
  url: string | undefined,
  args: readonly string[],
  stdin: string,
  env: Record<string, string> = {},
): Ran => {
  const rest = { ...process.env };
  delete rest['DATABASE_URL'];
  // `--no-env-file`: a machine's own `.env` names a DATABASE_URL, and "without a database" would not be.
  const done = Bun.spawnSync(['bun', '--no-env-file', 'run', SCRIPT, ...args], {
    stdin: Buffer.from(stdin),
    env: { ...rest, ...(url === undefined ? {} : { DATABASE_URL: url }), ...env },
  });
  return { code: done.exitCode, out: done.stdout.toString(), err: done.stderr.toString() };
};

const anAdministrator = async (
  db: Executor,
  { withPassword = true }: { withPassword?: boolean } = {},
): Promise<{ userId: string; email: string }> => {
  const user = await aUserRow(db, 'rescue');
  await db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', user.userId)
    .execute();
  if (withPassword) {
    await db
      .insertInto('accounts')
      .values({
        user_id: user.userId,
        provider_id: 'credential',
        account_id: user.userId,
        password: await hashPassword(OLD),
      })
      .execute();
  }
  return user;
};

const sessionsOf = async (db: Executor, userId: string): Promise<number> =>
  (await db.selectFrom('sessions').select('id').where('user_id', '=', userId).execute()).length;

const accountsOf = async (db: Executor, userId: string): Promise<number> =>
  (await db.selectFrom('accounts').select('id').where('user_id', '=', userId).execute()).length;

const signsIn = async (db: Executor, email: string, password: string): Promise<boolean> =>
  (await signInAdmin(aTestAuth(db), { email, password, clientAddress: '203.0.113.9' })).status ===
  200;

const aDatabase = async (): Promise<{ db: Executor; url: string }> => {
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  return { db: cloned.db, url: cloned.connectionString };
};

describe('integration: bun run admin:reset-password', () => {
  test('sets the password the library signs in with, ends every session of the account and no one else’s, and says only that', async () => {
    const { db, url } = await aDatabase();
    const admin = await anAdministrator(db);
    const other = await aUserRow(db, 'bystander');
    await aSession(db, systemClock, admin.userId);
    await aSession(db, systemClock, admin.userId);
    await aSession(db, systemClock, other.userId);
    expect(await signsIn(db, admin.email, OLD)).toBe(true);
    // The library's own sign-in made a session of its own.
    expect(await sessionsOf(db, admin.userId)).toBe(3);

    const ran = run(url, [admin.email.toUpperCase()], `${NEW}\r\nignored second line\n`);
    expect(ran).toEqual({ code: 0, out: `Password changed for ${admin.email}\n`, err: '' });
    expect(await signsIn(db, admin.email, NEW)).toBe(true);
    expect(await signsIn(db, admin.email, OLD)).toBe(false);
    // Every session of the administrator is gone — the one the check above just made is the only one left.
    expect(await sessionsOf(db, admin.userId)).toBe(1);
    expect(await sessionsOf(db, other.userId)).toBe(1);
    expect(await accountsOf(db, admin.userId)).toBe(1);
    const stored = await db
      .selectFrom('accounts')
      .select(['password', 'account_id', 'provider_id'])
      .where('user_id', '=', admin.userId)
      .executeTakeFirstOrThrow();
    expect([stored.provider_id, stored.account_id]).toEqual(['credential', admin.userId]);
    expect(stored.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(ran.out + ran.err).not.toContain(NEW);
    expect(ran.out + ran.err).not.toContain(stored.password ?? 'x');
    // It leaves a row on the server's trail: the account itself as the actor, no session, no value.
    const trail = await db
      .selectFrom('server_audit_log')
      .selectAll()
      .where('actor_user_id', '=', admin.userId)
      .execute();
    expect(trail.map((row) => [row.action, row.session_id])).toEqual([
      ['server.admin_password_reset', null],
    ]);
    expect(JSON.stringify(trail)).not.toContain(NEW);
  });

  test('an administrator with no password yet — one who came in through GitHub — is given one', async () => {
    const { db, url } = await aDatabase();
    const admin = await anAdministrator(db, { withPassword: false });
    expect(await accountsOf(db, admin.userId)).toBe(0);
    const ran = run(url, [admin.email], `${NEW}\n`);
    expect(ran.code).toBe(0);
    expect(await accountsOf(db, admin.userId)).toBe(1);
    expect(await signsIn(db, admin.email, NEW)).toBe(true);
  });

  test('an administrator whose authenticator app is lost: two-step verification is off with the reset, and said so (D-236)', async () => {
    const { db, url } = await aDatabase();
    const admin = await anAdministrator(db);
    await db
      .updateTable('users')
      .set({ two_factor_enabled: true })
      .where('id', '=', admin.userId)
      .execute();
    await db
      .insertInto('two_factors')
      .values({ user_id: admin.userId, secret: 'sealed', backup_codes: 'sealed', verified: true })
      .execute();
    const ran = run(url, [admin.email], `${NEW}\n`);
    expect(ran).toEqual({
      code: 0,
      out: `Password changed for ${admin.email}\nTwo-step verification is off for it now.\n`,
      err: '',
    });
    expect(
      await db.selectFrom('two_factors').where('user_id', '=', admin.userId).execute(),
    ).toEqual([]);
    const row = await db
      .selectFrom('users')
      .select('two_factor_enabled')
      .where('id', '=', admin.userId)
      .executeTakeFirstOrThrow();
    expect(row.two_factor_enabled).toBe(false);
    // The password alone signs in again, with no second step asked.
    expect(await signsIn(db, admin.email, NEW)).toBe(true);
  });

  test('a server whose passwords were turned off: they are on again with the reset, on the trail, and the restart said (D-239)', async () => {
    const { db, url } = await aDatabase();
    const admin = await anAdministrator(db);
    await db
      .insertInto('server_settings')
      .values({ id: true, password_sign_in: false })
      .onConflict((conflict) => conflict.column('id').doUpdateSet({ password_sign_in: false }))
      .execute();
    const ran = run(url, [admin.email], `${NEW}\n`);
    expect(ran).toEqual({
      code: 0,
      out: `Password changed for ${admin.email}\nPassword sign-in is on again. Restart the server for it to take effect.\n`,
      err: '',
    });
    const settings = await db
      .selectFrom('server_settings')
      .select('password_sign_in')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(settings.password_sign_in).toBe(true);
    const actions = await db
      .selectFrom('server_audit_log')
      .select(['action', 'actor_user_id'])
      .where('actor_user_id', '=', admin.userId)
      .orderBy('id')
      .execute();
    expect(actions.map((row) => row.action)).toEqual([
      'server.admin_password_reset',
      'server.password_sign_in_changed',
    ]);
    // On already, it says nothing of it and leaves no second row.
    const again = run(url, [admin.email], `${NEW}\n`);
    expect(again.out).toBe(`Password changed for ${admin.email}\n`);
    expect(
      await db
        .selectFrom('server_audit_log')
        .select('id')
        .where('actor_user_id', '=', admin.userId)
        .where('action', '=', 'server.password_sign_in_changed')
        .execute(),
    ).toHaveLength(1);
  });

  test('it is not a general reset: anyone but the server administrator is refused, in the words an unknown address gets, and nothing changes', async () => {
    const { db, url } = await aDatabase();
    const member = await aUserRow(db, 'ordinary');
    const erased = await anAdministrator(db);
    await db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', erased.userId)
      .execute();
    await aSession(db, systemClock, member.userId);
    const refusals = [
      run(url, [member.email], `${NEW}\n`),
      run(url, ['nobody@example.test'], `${NEW}\n`),
      run(url, [erased.email], `${NEW}\n`),
    ];
    for (const ran of refusals) {
      expect(ran.code).toBe(1);
      expect(ran.out).toBe('');
      expect(ran.err).toBe('No server administrator has that address. Nothing was changed.\n');
    }
    expect(await accountsOf(db, member.userId)).toBe(0);
    expect(await sessionsOf(db, member.userId)).toBe(1);
    expect(
      await db
        .selectFrom('server_audit_log')
        .select('id')
        .where('actor_user_id', 'in', [member.userId, erased.userId])
        .execute(),
    ).toEqual([]);
  });

  test('the password policy applies, and a refused password changes nothing', async () => {
    const { db, url } = await aDatabase();
    const admin = await anAdministrator(db);
    await aSession(db, systemClock, admin.userId);
    for (const weak of ['tiny', 'password1234', admin.email, '']) {
      const ran = run(url, [admin.email], `${weak}\n`);
      expect(ran.code).not.toBe(0);
      expect(ran.out).toBe('');
      if (weak !== '') expect(ran.err).not.toContain(weak);
    }
    expect(await signsIn(db, admin.email, OLD)).toBe(true);
    expect(await sessionsOf(db, admin.userId)).toBe(2);
  });

  test('a password given as an argument is refused and never repeated; so is one in the environment', async () => {
    const { db, url } = await aDatabase();
    const admin = await anAdministrator(db);
    await aSession(db, systemClock, admin.userId);
    const asArgument = run(url, [admin.email, NEW], '');
    expect(asArgument.code).not.toBe(0);
    expect(asArgument.out + asArgument.err).not.toContain(NEW);
    // Even with the password on standard input, a second argument is a refusal: it is a sign of a
    // command typed as if the password could go there.
    const asWellAsStdin = run(url, [admin.email, NEW], `${NEW}\n`);
    expect(asWellAsStdin.code).not.toBe(0);
    expect(asWellAsStdin.out + asWellAsStdin.err).not.toContain(NEW);
    const alone = run(url, [NEW], '');
    expect(alone.code).not.toBe(0);
    expect(alone.out + alone.err).not.toContain(NEW);
    // Nothing on standard input: the environment is not read for it.
    const asEnvironment = run(url, [admin.email], '', {
      PASSWORD: NEW,
      NEW_PASSWORD: NEW,
      ADMIN_PASSWORD: NEW,
    });
    expect(asEnvironment.code).not.toBe(0);
    expect(asEnvironment.out + asEnvironment.err).not.toContain(NEW);
    expect(await signsIn(db, admin.email, OLD)).toBe(true);
    expect(await signsIn(db, admin.email, NEW)).toBe(false);
    expect(await sessionsOf(db, admin.userId)).toBe(2);
  });

  test('without a database it refuses', () => {
    const ran = run(undefined, ['admin@example.test'], `${NEW}\n`);
    expect(ran.code).not.toBe(0);
    expect(ran.err).toContain('DATABASE_URL');
    expect(ran.err).not.toContain(NEW);
  });
});
