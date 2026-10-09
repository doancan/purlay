/**
 * Turning a GitHub account into a Purlay user, with every collision named.
 *
 * D-38 exists because the obvious implementation fails on the first sign-in by a
 * developer who has not made an email address public: the profile omits it and
 * the insert violates `NOT NULL`. Each of the four outcomes below is a decision
 * that was written down before it was met.
 *
 * The executor is an argument, so this runs inside a rolled-back transaction in a
 * test (D-46).
 */
import type { Executor } from '@purlay/db';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { GitHubEmail, GitHubProfile } from './github';

export interface ResolvedIdentity {
  readonly userId: string;
  /**
   * Set when the incoming `login` was already taken by somebody else and this
   * user was stored with a suffix. D-38 requires it to be logged. It is returned
   * rather than logged here, so this stays a decision over values, and
   * `sign-in.ts` writes the line — a fact with nowhere to go is a fact that
   * quietly stops existing.
   */
  readonly usernameCollision?: { readonly wanted: string; readonly stored: string };
}

/**
 * The address that is both primary **and** verified. Anything else is refused:
 * an unverified address is a claim by whoever typed it, and the email is the
 * identity anchor Phase 2's magic links resolve against (D-11, D-38).
 */
const anchorEmail = (emails: readonly GitHubEmail[]): string => {
  const address = emails.find((entry) => entry.primary && entry.verified)?.email;
  if (address === undefined) {
    throw new AppError({
      code: 'EMAIL_REQUIRED',
      message:
        'Purlay needs a primary, verified email address on your GitHub account. Add or verify one and sign in again.',
    });
  }
  // Lowercase ASCII at the boundary, so the `COLLATE "C"` column compares
  // byte-wise and two spellings of one address cannot become two accounts (D-40).
  return address.toLowerCase();
};

/** The columns' widths (`SCHEMA.md` §users): `username` is GitHub's own limit. */
const USERNAME_MAX = 39;
const DISPLAY_NAME_MAX = 128;

/**
 * Cut to the column, by characters as the database counts them — not by UTF-16
 * units, which would split a pair and store a lone surrogate. Sign-in shortens a
 * value GitHub controls; it never fails on one (#233).
 */
const fitted = (value: string, max: number): string => Array.from(value).slice(0, max).join('');

/**
 * GitHub lets an account be renamed and the freed name be taken by someone else,
 * so a refresh can collide with a live row. The incoming user takes a suffix;
 * identity is `github_id`, and `username` is display-only (D-38).
 */
const availableUsername = async (
  executor: Executor,
  wanted: string,
  selfId: string | undefined,
): Promise<string> => {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    // The suffix is part of the 39, so the name gives up room for it.
    const tail = suffix === 0 ? '' : `-${String(suffix)}`;
    const candidate = `${fitted(wanted, USERNAME_MAX - tail.length)}${tail}`;
    const taken = await executor
      .selectFrom('users')
      .select('id')
      .where('username', '=', candidate)
      .executeTakeFirst();
    if (taken === undefined || taken.id === selfId) return candidate;
  }
  // A hundred people cannot all have been renamed onto one login. Refusing beats
  // looping, and beats inventing a name nobody can predict.
  throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
};

export const resolveIdentity = async (
  executor: Executor,
  clock: Clock,
  profile: GitHubProfile,
  emails: readonly GitHubEmail[],
): Promise<ResolvedIdentity> => {
  const email = anchorEmail(emails);
  const displayName = fitted(profile.name ?? profile.login, DISPLAY_NAME_MAX);
  const now = clock.now();

  const existing = await executor
    .selectFrom('users')
    .select(['id', 'username'])
    .where('github_id', '=', String(profile.id))
    .where('deleted_at', 'is', null)
    .executeTakeFirst();

  if (existing !== undefined) {
    const username = await availableUsername(executor, profile.login, existing.id);
    await executor
      .updateTable('users')
      .set({
        username,
        display_name: displayName,
        avatar_url: profile.avatarUrl,
        updated_at: now,
      })
      .where('id', '=', existing.id)
      .execute();
    return {
      userId: existing.id,
      ...(username === profile.login
        ? {}
        : { usernameCollision: { wanted: profile.login, stored: username } }),
    };
  }

  /**
   * The address already belongs to a different account. **Never linked
   * silently**: "same email, therefore the same person" is a classic
   * account-takeover surface, and it is no safer between two GitHub accounts than
   * between two providers (D-5, D-38).
   */
  const emailOwner = await executor
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .executeTakeFirst();
  if (emailOwner !== undefined) {
    throw new AppError({
      code: 'ACCOUNT_EMAIL_CONFLICT',
      message: 'That email address already belongs to another Purlay account.',
    });
  }

  const username = await availableUsername(executor, profile.login, undefined);
  const created = await executor
    .insertInto('users')
    .values({
      github_id: String(profile.id),
      email,
      username,
      display_name: displayName,
      avatar_url: profile.avatarUrl,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  return {
    userId: created.id,
    ...(username === profile.login
      ? {}
      : { usernameCollision: { wanted: profile.login, stored: username } }),
  };
};
