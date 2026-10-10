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
 * C0, DEL and C1 control characters. PostgreSQL refuses a NUL in text outright, and
 * the rest have no place in a name shown to other people.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const CONTROLS = new RegExp(CONTROL.source, 'g');

/**
 * What GitHub said about the account, made safe to store. The values belong to
 * another system, so sign-in cleans them and carries on rather than failing on them
 * (D-78): control characters are removed, a login with nothing left becomes a name
 * made from the immutable id, and an avatar address with one is dropped.
 */
const cleaned = (given: GitHubProfile): GitHubProfile => {
  const login = given.login.replace(CONTROLS, '');
  const name = given.name?.replace(CONTROLS, '') ?? '';
  return {
    id: given.id,
    login: login === '' ? `user-${String(given.id)}` : login,
    name: name === '' ? null : name,
    avatarUrl: given.avatarUrl === null || CONTROL.test(given.avatarUrl) ? null : given.avatarUrl,
  };
};

/**
 * The address that is both primary **and** verified. Anything else is refused:
 * an unverified address is a claim by whoever typed it, and the email is the
 * identity anchor Phase 2's magic links resolve against (D-11, D-38).
 */
const anchorEmail = (emails: readonly GitHubEmail[]): string => {
  // An address with a control character is not an address, and is never repaired:
  // stripping one would turn it into a different, possibly somebody else's.
  const address = emails.find(
    (entry) => entry.primary && entry.verified && !CONTROL.test(entry.email),
  )?.email;
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
 * What GitHub's free-text `name` may not carry into a column: control characters
 * (PostgreSQL cannot store a NUL), a lone surrogate, and the bidirectional
 * overrides that make one name read as another. The same set a workspace or
 * channel name is refused for; here it is removed, because sign-in never fails on
 * a value GitHub controls (#233).
 */
const UNSAFE_IN_NAME =
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const cleanedName = (value: string): string => value.replace(UNSAFE_IN_NAME, '').trim();

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
  given: GitHubProfile,
  emails: readonly GitHubEmail[],
): Promise<ResolvedIdentity> => {
  const profile = cleaned(given);
  const email = anchorEmail(emails);
  const displayName = fitted(
    cleanedName(profile.name ?? '') || cleanedName(profile.login) || profile.login,
    DISPLAY_NAME_MAX,
  );
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
    .select(['github_id', 'deleted_at'])
    .where('email', '=', email)
    .executeTakeFirst();
  // The owner may be this very account, made a moment ago by the other half of a
  // double-clicked callback: same GitHub id, so not a stranger and not a conflict.
  const isThisAccount =
    emailOwner?.github_id === String(profile.id) && emailOwner.deleted_at === null;
  if (emailOwner !== undefined && !isThisAccount) {
    throw new AppError({
      code: 'ACCOUNT_EMAIL_CONFLICT',
      message: 'That email address already belongs to another Purlay account.',
    });
  }

  const username = await availableUsername(executor, profile.login, undefined);
  // The lookups above and this insert race: the same GitHub account completing sign-in
  // twice at once (a double-clicked callback, two tabs) passes them twice. **Any** unique
  // key can be the one that loses — `github_id` when the first row is already visible,
  // `email` when it commits after this statement's check of the first and before its
  // check of the second (D-78 handled the first and answered the second as a stranger
  // holding the address: a 409 for a person who had done nothing wrong). So the insert
  // names no key and does nothing on any conflict; what a conflict meant is decided by
  // reading, below, with the first row now committed and visible.
  const created = await executor
    .insertInto('users')
    .values({
      github_id: String(profile.id),
      email,
      username,
      display_name: displayName,
      avatar_url: profile.avatarUrl,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();

  if (created === undefined) {
    // Somebody got there first. If it was this account, refresh the row it made and carry
    // on — the username stays as the first stored it. If it was not, the address is a
    // stranger's, and that is the conflict the lookups above exist to name.
    const winner = await executor
      .updateTable('users')
      .set({ display_name: displayName, avatar_url: profile.avatarUrl, updated_at: now })
      .where('github_id', '=', String(profile.id))
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (winner !== undefined) return { userId: winner.id };
    const stranger = await executor
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    if (stranger !== undefined) {
      throw new AppError({
        code: 'ACCOUNT_EMAIL_CONFLICT',
        message: 'That email address already belongs to another Purlay account.',
      });
    }
    // The account was deleted and its GitHub id is deliberately never reused (D-38), or
    // the username was taken in the same instant: no row to refresh, none to create. No
    // Phase 0 path deletes a user; the contract has no code for this yet, and inventing
    // one is not this change's to do.
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
  }

  return {
    userId: created.id,
    ...(username === profile.login
      ? {}
      : { usernameCollision: { wanted: profile.login, stored: username } }),
  };
};
