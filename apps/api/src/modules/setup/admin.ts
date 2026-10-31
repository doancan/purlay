/**
 * The setup's administrator (D-179 §4.3): the one account a password is ever given to, made at the step
 * after the claim, once, and signed in with that password by the sign-in library itself.
 *
 * - **Under the claim, at its step, once.** Only the browser holding the claim (`requireSetupClaim`'s
 *   session, weighed again under the row's lock), only while the setup stands at `claim`, and only
 *   while no administrator is recorded: a second is `admin-exists`, whatever it is called.
 * - **One transaction.** The account through the library's own adapter — `createUser`, so its user hook
 *   gives the username by the rules every account is named by (`identity.ts`, Ruling R23), and
 *   `linkAccount` with a credential (`provider_id` `credential`, `account_id` the user's id, the
 *   library's own hash) — then `users.is_server_admin` (Ruling R16), `setup_state.admin_user_id` and the
 *   `admin` step, all in the transaction that holds the row. The library is pointed at that transaction
 *   by an adapter of its own kind over it (`kyselyAdapter`, `runWithAdapter`), so a failure anywhere
 *   leaves no user, no password and no administrator (Ruling R10).
 * - **The address unverified.** Whoever has the code runs the server, but has not shown the address is
 *   theirs; one mistyped could be taken through GitHub (spec §7.9). The wizard's own mail proves it
 *   later (Ruling R32); until then no magic link reaches the account (`magic-link.ts`).
 * - **Refused in words, never by the database**: an address that is not one mailbox, a name empty, over
 *   128 characters or carrying a control or format character, a password the policy refuses
 *   (`passwordProblem`), an address an account has already. The claim's holder runs the server, so
 *   `email-taken` tells them nothing they may not know.
 *
 * Signing in is the library's (`signInAdmin`): its `/sign-in/email`, its cookie, its session row —
 * nothing here makes a session by hand.
 */
import { kyselyAdapter } from '@better-auth/kysely-adapter';
import { runWithAdapter } from '@better-auth/core/context';
import { sessionTokenHashing, type Executor } from '@purlay/db';
import {
  DISPLAY_NAME_MAX,
  FORBIDDEN_IN_NAME,
  normalisedMailbox,
  passwordProblem,
  type PasswordProblem,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import { CLIENT_ADDRESS_HEADER, type Auth } from '../auth/better-auth';
import { heldBy, SetupRefused, type SetupClaimDigest, type SetupRefusal } from './setup';

/** Why the administrator was not made, beyond the claim's own refusals (`SetupRefused`). */
export type AdminRefusal =
  | { readonly reason: 'admin-exists' }
  | { readonly reason: 'email-taken' }
  | { readonly reason: 'invalid-email' }
  | { readonly reason: 'invalid-name' }
  | { readonly reason: 'weak-password'; readonly problem: PasswordProblem };

const SENTENCES: Record<AdminRefusal['reason'], string> = {
  'admin-exists': 'This setup has its administrator already.',
  'email-taken': 'An account has that address already.',
  'invalid-email': 'That is not an email address.',
  'invalid-name': 'Give a name of one to 128 characters.',
  'weak-password': 'Choose another password.',
};

export class AdminRefused extends Error {
  readonly refusal: AdminRefusal;

  constructor(refusal: AdminRefusal) {
    super(SENTENCES[refusal.reason]);
    this.name = 'AdminRefused';
    this.refusal = refusal;
  }
}

export interface AdminDependencies {
  readonly database: Executor;
  /** The serving instance: its options, its user hook and its hash are what the account is made with. */
  readonly auth: Auth;
  readonly clock: Clock;
}

export interface AdminInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

/** A unique index refused the write: an account with the address made by another request meanwhile. */
const emailTaken = (error: unknown): boolean => {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    const { code, constraint } = at as { readonly code?: unknown; readonly constraint?: unknown };
    if (code === '23505' && constraint === 'users_email_key') return true;
  }
  return false;
};

/**
 * The administrator, made under the session's claim: the id of the account, and nothing else — the
 * password and its hash are never handed back.
 */
export const createAdmin = async (
  { database, auth, clock }: AdminDependencies,
  session: SetupClaimDigest,
  input: AdminInput,
): Promise<{ userId: string }> => {
  const email = normalisedMailbox(input.email);
  if (email === undefined) throw new AdminRefused({ reason: 'invalid-email' });
  const name = input.name.trim();
  const length = Array.from(name).length;
  if (length === 0 || length > DISPLAY_NAME_MAX || FORBIDDEN_IN_NAME.test(name)) {
    throw new AdminRefused({ reason: 'invalid-name' });
  }
  const problem = passwordProblem(input.password, { email, name });
  if (problem !== undefined) throw new AdminRefused({ reason: 'weak-password', problem });

  const context = await auth.$context;

  let outcome: { readonly userId: string } | SetupRefusal | AdminRefusal;
  try {
    outcome = await atomicallyOn(database)(async (transaction) => {
      const state = await heldBy(transaction, session);
      if ('reason' in state) return state;
      if (state.admin_user_id !== null) return { reason: 'admin-exists' as const };
      if (state.step_reached !== 'claim') return { reason: 'out-of-order' as const };
      const taken = await transaction
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (taken !== undefined) return { reason: 'email-taken' as const };
      // Hashed only now, past every refusal: scrypt is the slow part, and nobody without the claim may
      // make the server spend it. The row stays locked meanwhile — once in a server's life.
      const hash = await context.password.hash(input.password);

      // The library's adapter, over this transaction: every write it makes below is in it.
      const adapter = kyselyAdapter(transaction.withPlugin(sessionTokenHashing()), {
        type: 'postgres',
        transaction: false,
      })(context.options);
      const userId = await runWithAdapter(adapter, async () => {
        const user = await context.internalAdapter.createUser(
          { email, name, emailVerified: false },
          { method: 'email-password' },
        );
        await context.internalAdapter.linkAccount({
          userId: user.id,
          providerId: 'credential',
          accountId: user.id,
          password: hash,
        });
        return user.id;
      });
      await transaction
        .updateTable('users')
        .set({ is_server_admin: true })
        .where('id', '=', userId)
        .execute();
      const now = clock.now();
      await transaction
        .updateTable('setup_state')
        .set({
          admin_user_id: userId,
          step_reached: 'admin',
          step_reached_at: now,
          claim_seen_at: now,
        })
        .where('id', '=', true)
        .execute();
      return { userId };
    });
  } catch (error) {
    if (emailTaken(error)) throw new AdminRefused({ reason: 'email-taken' });
    throw error;
  }
  if ('userId' in outcome) return { userId: outcome.userId };
  if (
    outcome.reason === 'admin-exists' ||
    outcome.reason === 'email-taken' ||
    outcome.reason === 'invalid-email' ||
    outcome.reason === 'invalid-name' ||
    outcome.reason === 'weak-password'
  ) {
    throw new AdminRefused(outcome);
  }
  throw new SetupRefused(outcome);
};

/** Who signs in, and from where: the client's address is required, never a shared bucket by default. */
export interface AdminSignIn {
  readonly email: string;
  readonly password: string;
  /** The address ingress decided on (`clientAddress`), as `answerAuth` hands the library its own. */
  readonly clientAddress: string;
}

/**
 * The administrator signed in with the password, by the library (`Auth.passwordSignIn`): its answer to
 * `/sign-in/email`, the attempt counted as the route counts it. **Only its `Set-Cookie` headers are for
 * the browser**: its JSON body carries the session's raw token, which never leaves the server.
 */
export const signInAdmin = async (
  auth: Auth,
  { email, password, clientAddress }: AdminSignIn,
): Promise<Response> =>
  // The address as `createAdmin` stored it: the library compares it lower-cased but untrimmed.
  await auth.passwordSignIn(
    normalisedMailbox(email) ?? email,
    password,
    new Headers({ [CLIENT_ADDRESS_HEADER]: clientAddress }),
  );
