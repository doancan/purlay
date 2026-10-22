/**
 * What a GitHub account becomes in Purlay's own columns: the names a sign-in takes from it, made safe
 * to store, and the login it holds. Who the account is, and whether the address is one that may be
 * trusted, is the sign-in library's to decide (`better-auth.ts`, D-179); this writes what follows.
 *
 * The executor is an argument, so this runs inside a rolled-back transaction in a test (D-46).
 */
import { isErased } from '@purlay/types';
import { BROADCAST_NAMES } from '@purlay/markdown';
import { sql, type Executor } from '@purlay/db';
import { AppError } from '../../platform/errors';
import { atomicallyOn } from '../../platform/transactions';
import type { Clock } from '../../platform/clock';
import type { GitHubProfile } from './github';

export interface ResolvedIdentity {
  readonly userId: string;
  /**
   * Set when the incoming `login` was already taken by somebody else and this
   * user was stored with a suffix. D-38 requires it to be logged. It is returned
   * rather than logged here, so this stays a decision over values, and
   * `better-auth.ts` writes the line — a fact with nowhere to go is a fact that
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
export const cleanedProfile = (given: GitHubProfile): GitHubProfile => {
  const login = given.login.replace(CONTROLS, '');
  const name = given.name?.replace(CONTROLS, '') ?? '';
  return {
    id: given.id,
    login: login === '' ? `user-${String(given.id)}` : login,
    name: name === '' ? null : name,
    avatarUrl: given.avatarUrl === null || CONTROL.test(given.avatarUrl) ? null : given.avatarUrl,
  };
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
 * A name a living account may take: none begins as an erased one's does (D-139 §5), so a GitHub login or
 * an address that happens to is given `user-` before it, and stays a person rather than a tombstone.
 */
export const livingName = (wanted: string): string =>
  isErased({ username: wanted }) ? `user-${wanted}` : wanted;

/**
 * A username shaped from anything — a GitHub login, an address's local part, a value a client sent —
 * into what a mention can name (D-138 §5): lower-case letters, digits and single hyphens between
 * them, at most 39, never a broadcast name. `null` when nothing is left. No value reaches the column
 * without passing here and then `availableUsername`, so nobody can name themselves after somebody
 * else (D-179, R23).
 */
export const shapedUsername = (value: string): string | null => {
  const shaped = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, USERNAME_MAX)
    .replace(/-+$/, '');
  return shaped === '' || BROADCAST_NAMES.has(shaped) ? null : shaped;
};

/**
 * A username from an address's local part (D-138 §5): what an account a link makes is named, before
 * `availableUsername` makes it unique; `null` when nothing is left.
 */
export const usernameFrom = (email: string): string | null =>
  shapedUsername(email.slice(0, email.lastIndexOf('@')));

/**
 * GitHub lets an account be renamed and the freed name be taken by someone else,
 * so a refresh can collide with a live row. The incoming user takes a suffix;
 * identity is `github_id`, and `username` is display-only (D-38).
 */
export const availableUsername = async (
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

/**
 * The login is this GitHub account's now: written on its row, and taken from any other account that
 * still holds it in any case — renamed away from it at GitHub, and not signed in since. It is what
 * `WORKSPACE_CREATORS` is matched against (D-169), never the username, which only starts from it.
 */
const holdLogin = async (executor: Executor, githubId: string, login: string): Promise<void> => {
  await executor
    .updateTable('users')
    .set({ github_login: null })
    .where(sql<string>`lower(github_login)`, '=', login.toLowerCase())
    .where((where) =>
      where.or([where('github_id', 'is', null), where('github_id', '!=', githubId)]),
    )
    .execute();
  await executor
    .updateTable('users')
    .set({ github_login: login })
    .where('github_id', '=', githubId)
    .where('deleted_at', 'is', null)
    .execute();
};

/**
 * The name GitHub gives an account it makes, cleaned for a column (#233): the profile's name, else the
 * login, never failing on what GitHub sent.
 */
export const githubDisplayName = (profile: GitHubProfile): string =>
  fitted(
    cleanedName(profile.name ?? '') || cleanedName(profile.login) || profile.login,
    DISPLAY_NAME_MAX,
  );

/** The username GitHub's login asks for, before `availableUsername` settles who already has it. */
export const githubUsernameWanted = (profile: GitHubProfile): string =>
  livingName(shapedUsername(profile.login) ?? `user-${String(profile.id)}`);

/** What a GitHub sign-in through the library has finished with, for the columns that are ours. */
export interface GitHubSignIn {
  readonly userId: string;
  /** Cleaned (`cleanedProfile`). */
  readonly profile: GitHubProfile;
  /** The library made the account in this very sign-in. */
  readonly made: boolean;
}

/**
 * What a GitHub sign-in writes beyond the library's own rows (D-169, D-176, D-179 §5), once the
 * library has decided whose account it is and before it opens the session:
 *
 * - **An account GitHub made** — this sign-in's, or an earlier one's — has its username and display
 *   name from GitHub, refreshed on every sign-in (D-38), its picture, and `github_connected_at` NULL.
 * - **An account made by email, linked now** because GitHub vouches for its verified address (D-179 §5)
 *   gets `github_id` and `github_connected_at`, and the picture; its names were never GitHub's and stay.
 *   Once connected it keeps them on every later sign-in (D-176 §6).
 * - **Every one** holds the login, taken from any other account that still has it (`holdLogin`): it is
 *   what `WORKSPACE_CREATORS` is matched against (D-169).
 *
 * Only while the account is live: an erasure that committed first leaves a tombstone, and nothing of
 * the person is written back onto it (D-139 §5, I-11) — the sign-in is refused instead.
 */
export const recordGitHubSignIn = async (
  executor: Executor,
  clock: Clock,
  { userId, profile, made }: GitHubSignIn,
): Promise<ResolvedIdentity> =>
  // One transaction: a refresh that fails half-way leaves the account as it was, never with new
  // names under an old login, or a login held by nobody.
  await atomicallyOn(executor)(async (transaction) => {
    const githubId = String(profile.id);
    // Locked, erased or not: an erasure waits for this to end, and one that ended first is refused by
    // the write below, which is the one guard against writing a person back onto a tombstone.
    const account = await transaction
      .selectFrom('users')
      .select(['id', 'github_id', 'github_connected_at'])
      .where('id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if (account === undefined) {
      throw new AppError({
        code: 'UNAUTHENTICATED',
        message: 'That account is gone. Sign in again.',
      });
    }
    // Made by GitHub: this sign-in made it, or it has GitHub's id and was never connected to one —
    // its id written as it was made (`better-auth.ts`'s user hook), so this holds whatever failed after.
    const githubMade =
      made || (account.github_id === githubId && account.github_connected_at === null);
    const now = clock.now();
    const wanted = githubUsernameWanted(profile);
    const username = githubMade ? await availableUsername(transaction, wanted, userId) : undefined;
    const written = await transaction
      .updateTable('users')
      .set({
        github_id: githubId,
        avatar_url: profile.avatarUrl,
        updated_at: now,
        ...(username === undefined
          ? // Connected now, or before: the moment it first was is kept.
            { github_connected_at: account.github_connected_at ?? now }
          : { username, display_name: githubDisplayName(profile), github_connected_at: null }),
      })
      .where('id', '=', userId)
      // Only while it is live (D-139 §5, I-11): nothing of the person is written onto a tombstone.
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (written === undefined) {
      throw new AppError({
        code: 'UNAUTHENTICATED',
        message: 'That account is gone. Sign in again.',
      });
    }
    await holdLogin(transaction, githubId, profile.login);
    return {
      userId,
      ...(username === undefined || username === wanted
        ? {}
        : { usernameCollision: { wanted, stored: username } }),
    };
  });
