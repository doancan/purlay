/**
 * The password policy (D-179 §4): the one home of what a password may be, read by the setup that makes
 * the administrator's (`modules/setup/admin.ts`), by the sign-in library's configuration and its hook on
 * the routes that set a new one (`modules/auth/better-auth.ts`), and by any screen that checks one as it
 * is typed. Only the setup administrator has a password; everybody else signs in by link or GitHub.
 *
 * Lengths are counted as the library counts them, in UTF-16 units (`password.length`), so the library's
 * own refusals (`PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG`) and these never disagree about one password.
 * No network call and no breach lookup: a short list of the commonest passwords long enough to pass the
 * length, and the person's own address and name.
 */

/** Shorter is refused. NIST SP 800-63B asks for eight at least; ten for the server's administrator. */
export const PASSWORD_MIN_LENGTH = 10;

/** Longer is refused before any hashing: a password is hashed on every sign-in (scrypt), and its cost grows with it. */
export const PASSWORD_MAX_LENGTH = 128;

/** An address's local part or a name shorter than this is not looked for: "al" or "bo" is in half the language. */
const OWN_WORD_MIN_LENGTH = 4;

/**
 * The commonest passwords of ten characters or more, lower case, from the published lists of leaked
 * passwords (the ones shorter than ten are refused by length already). Small on purpose: a guesser
 * tries these first, and the throttle on sign-in (`D-179 §4`) bounds everything after them.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '1234567890',
  '0123456789',
  '0987654321',
  '1111111111',
  '0000000000',
  '1122334455',
  '1234512345',
  '12345678910',
  '123456789a',
  'a123456789',
  '1q2w3e4r5t',
  '1q2w3e4r5t6y',
  'q1w2e3r4t5',
  'qwertyuiop',
  'qwerty1234',
  'qwerty12345',
  '1qaz2wsx3edc',
  'zaq12wsxcde3',
  'asdfghjkl1',
  'password12',
  'password123',
  'password1234',
  'password!1',
  'passw0rd123',
  'p@ssw0rd123',
  'iloveyou123',
  'iloveyou12',
  'administrator',
  'admin12345',
  'admin123456',
  'letmein123',
  'welcome123',
  'welcome1234',
  'changeme123',
  'football123',
  'baseball123',
  'monkey12345',
  'sunshine123',
  'princess123',
  'superman123',
  'starwars123',
  'trustno1234',
  'abcdefghij',
  'abc1234567',
  'abcd123456',
  'qazwsxedcrfv',
]);

/** A common password with what people add to one taken off its end: `Password123!` is `password`. */
const stem = (folded: string): string => folded.replace(/[\p{N}\p{P}\p{S}\s]+$/u, '');

/** The stems of the common list long enough to mean something (`1234567890` has none). */
const COMMON_STEMS: ReadonlySet<string> = new Set(
  [...COMMON_PASSWORDS].map(stem).filter((value) => value.length >= OWN_WORD_MIN_LENGTH),
);

/** A control character (`Cc`): a NUL, a line break, an escape. Nothing a person types into a password. */
const CONTROL = /\p{Cc}/u;

/** Fewer different characters than this is a pattern, not a password (`abababababab`). */
const DISTINCT_MIN = 4;

/** Why a password is refused, or nothing. */
export type PasswordProblem =
  | 'too-short'
  | 'too-long'
  | 'invalid-character'
  | 'blank'
  | 'contains-email'
  | 'contains-name'
  | 'common'
  | 'repetitive';

/** Whose password it is: what it may not contain. */
export interface PasswordOwner {
  readonly email: string;
  readonly name: string;
}

/** Compared as a person reads it: compatibility forms folded (a full-width `Ａ` is `a`), then lower case. */
const folded = (value: string): string => value.normalize('NFKC').toLowerCase();

/**
 * The first rule `password` breaks for its owner, or `undefined` when it may be set. Lengths are the
 * password as sent; every comparison is of its folded form.
 */
export const passwordProblem = (
  password: string,
  owner: PasswordOwner,
): PasswordProblem | undefined => {
  if (password.length < PASSWORD_MIN_LENGTH) return 'too-short';
  if (password.length > PASSWORD_MAX_LENGTH) return 'too-long';
  if (CONTROL.test(password)) return 'invalid-character';
  if (password.trim() === '') return 'blank';
  const text = folded(password);
  const email = folded(owner.email.trim());
  const local = email.slice(0, Math.max(0, email.lastIndexOf('@')));
  if (email !== '' && text.includes(email)) return 'contains-email';
  if (local.length >= OWN_WORD_MIN_LENGTH && text.includes(local)) return 'contains-email';
  const name = folded(owner.name.trim());
  const words = [name, ...name.split(/[^\p{L}\p{N}]+/u)];
  if (words.some((word) => word.length >= OWN_WORD_MIN_LENGTH && text.includes(word))) {
    return 'contains-name';
  }
  if (COMMON_PASSWORDS.has(text) || COMMON_STEMS.has(stem(text))) return 'common';
  if (new Set(text).size < DISTINCT_MIN) return 'repetitive';
  return undefined;
};
