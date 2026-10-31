/**
 * Two-step verification for an account that signs in with a password (D-236): after the password, a code from
 * an authenticator app or one of the backup codes. The routes are the sign-in library's own, under
 * `AUTH_BASE_PATH`; these are their answers as the client reads them, and the numbers both halves say.
 */
import { Type, type Static } from '@sinclair/typebox';

/** The digits of an authenticator app's code (RFC 6238, the library's default and every app's). */
export const TWO_FACTOR_CODE_DIGITS = 6;

/** How long the second step waits for its code once the password was right: the challenge's cookie and row. */
export const TWO_FACTOR_CHALLENGE_MINUTES = 10;

/** Wrong codes in a row at sign-in, across challenges and kinds of code, before the second step locks. */
export const TWO_FACTOR_FAILURES_BEFORE_LOCK = 10;

/** How long the second step stays locked after them. */
export const TWO_FACTOR_LOCK_MINUTES = 15;

/**
 * `POST /auth/sign-in/email`'s answer, as far as the client reads it: `twoFactorRedirect` is `true` when the
 * password was right and the account asks for its second step — no session yet, only the challenge's cookie.
 */
export const PasswordSignInAnswer = Type.Object({
  twoFactorRedirect: Type.Optional(Type.Boolean()),
});
export type PasswordSignInAnswer = Static<typeof PasswordSignInAnswer>;

/**
 * `POST /auth/two-factor/enable`'s answer: the key as an `otpauth://` link, for the app to read as a QR code or
 * to be typed, and the backup codes, shown this once. Nothing is on until a code from the app is right.
 */
export const TwoFactorEnrolment = Type.Object({
  totpURI: Type.String(),
  backupCodes: Type.Array(Type.String()),
});
export type TwoFactorEnrolment = Static<typeof TwoFactorEnrolment>;

/** `POST /auth/two-factor/generate-backup-codes`'s answer: new codes, shown this once; the old ones are spent. */
export const BackupCodes = Type.Object({ backupCodes: Type.Array(Type.String()) });
export type BackupCodes = Static<typeof BackupCodes>;
