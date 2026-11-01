/**
 * The server administrator's password, set again from the server (D-179 §4, `bun run admin:reset-password`):
 * the break-glass for the one account that has a password, for when it is lost. No mail and no browser
 * can reset it — a password is reset where the server runs, by whoever runs it — and this is **not a
 * general reset**: it refuses every account that is not the server's administrator.
 *
 * - **The row as the library reads it** (Ruling R10, `admin.ts`): one `accounts` row with `provider_id`
 *   `credential`, `account_id` the user's id, and the library's own scrypt (`hashPassword`); updated if
 *   the administrator has one, made if not (an administrator who came in through GitHub only).
 * - **The policy applies** (`passwordProblem`, with the address and the name), said by the rule's name.
 * - **One transaction, and every session ends in it**: the password is no longer theirs alone, so a
 *   session somebody stole dies with it. Nothing is published: this is another process, with no bus.
 *   A socket the account holds open is ended by the server's liveness sweep (`realtime/liveness.ts`)
 *   within about half a minute, as for any session removed by the database itself.
 * - **Two-step verification is turned off with it** (D-236): the break-glass is for an account whose way in is
 *   lost, an authenticator app as much as a password; the person turns it on again with the new password.
 * - **Password sign-in is turned on again with it** (D-239), where the server's administrator had turned it off:
 *   the break-glass is for a server whose other ways in are gone — a provider down, a secret a rotated key cannot
 *   open — and a password that does not sign in is no way back. The running server reads its settings when it
 *   starts or when it changes them itself, so the command says to restart it. Its own row on the trail
 *   (`server.password_sign_in_changed`).
 * - **It leaves a row** on the server's trail (`server.admin_password_reset`, the account itself as the
 *   actor, no session, never a value), in the same transaction.
 * - **Nothing secret is returned**: not the password, not its hash.
 */
import { hashPassword } from 'better-auth/crypto';
import type { Executor } from '@purlay/db';
import { normalisedMailbox, passwordProblem, type PasswordProblem } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { recordServerAudit } from '../audit/server-audit';
import { atomicallyOn } from '../../platform/transactions';

export type ResetOutcome =
  | {
      readonly ok: true;
      readonly email: string;
      readonly sessionsEnded: number;
      /** Whether two-step verification was on, and is now off. */
      readonly twoFactorOff: boolean;
      /** Whether password sign-in was off, and is now on (D-239): the running server needs a restart for it. */
      readonly passwordsOn: boolean;
    }
  /** No account with that address is the server's administrator — or there is no such account: one answer. */
  | { readonly ok: false; readonly reason: 'not-an-administrator' }
  | { readonly ok: false; readonly reason: 'invalid-email' }
  | { readonly ok: false; readonly reason: 'weak-password'; readonly problem: PasswordProblem };

export const resetAdministratorPassword = async (
  database: Executor,
  input: { readonly email: string; readonly password: string },
  clock: Clock,
): Promise<ResetOutcome> => {
  const email = normalisedMailbox(input.email);
  if (email === undefined) return { ok: false, reason: 'invalid-email' };
  return await atomicallyOn(database)(async (transaction): Promise<ResetOutcome> => {
    const administrator = await transaction
      .selectFrom('users')
      .select(['id', 'display_name'])
      .where('email', '=', email)
      .where('is_server_admin', '=', true)
      .where('deleted_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (administrator === undefined) return { ok: false, reason: 'not-an-administrator' };
    const problem = passwordProblem(input.password, { email, name: administrator.display_name });
    if (problem !== undefined) return { ok: false, reason: 'weak-password', problem };
    const hash = await hashPassword(input.password);
    await transaction
      .insertInto('accounts')
      .values({
        user_id: administrator.id,
        provider_id: 'credential',
        account_id: administrator.id,
        password: hash,
      })
      .onConflict((conflict) =>
        conflict.columns(['provider_id', 'account_id']).doUpdateSet({
          password: hash,
          updated_at: clock.now(),
        }),
      )
      .execute();
    const ended = await transaction
      .deleteFrom('sessions')
      .where('user_id', '=', administrator.id)
      .returning('id')
      .execute();
    const secondStep = await transaction
      .deleteFrom('two_factors')
      .where('user_id', '=', administrator.id)
      .returning('id')
      .execute();
    await transaction
      .updateTable('users')
      .set({ two_factor_enabled: false })
      .where('id', '=', administrator.id)
      .execute();
    await recordServerAudit(transaction, clock, {
      actorUserId: administrator.id,
      action: 'server.admin_password_reset',
    });
    const passwordsOn = await transaction
      .updateTable('server_settings')
      .set({ password_sign_in: true, updated_at: clock.now() })
      .where('password_sign_in', '=', false)
      .returning('id')
      .executeTakeFirst();
    if (passwordsOn !== undefined) {
      await recordServerAudit(transaction, clock, {
        actorUserId: administrator.id,
        action: 'server.password_sign_in_changed',
      });
    }
    return {
      ok: true,
      email,
      sessionsEnded: ended.length,
      twoFactorOff: secondStep.length > 0,
      passwordsOn: passwordsOn !== undefined,
    };
  });
};
