/**
 * Sign in with Google (D-250): the OIDC core of `oidc.ts`, verifying Google's `id_token` exactly as it verifies
 * any provider's, with what makes Google itself said here.
 *
 * **The issuer, with or without its scheme.** Google writes `iss` as `https://accounts.google.com` or as
 * `accounts.google.com` (its own documentation says both), so a token may carry either — for Google alone. The
 * generic provider keeps exact equality, and discovery is never widened: the document's `issuer` must still be
 * the configured one byte for byte.
 *
 * **The account is the bare `sub`.** Google's issuer is fixed, so the subject alone is unique: no issuer is
 * joined before it as the generic provider's account is.
 *
 * **Whose say an address is** (`authoritativeForGoogle`): Google vouches for an address with `email_verified`,
 * but only some addresses are Google's to vouch for — a Gmail address, or one in a Workspace domain the token
 * names in `hd`. Any other address Google knows was verified once, by somebody, and may since have changed
 * hands; it is not enough to link an existing account by (D-250). The rule is the caller's to apply, in
 * `admit`, which the sign-in hands in with the database it needs. The same rule says what an account Google
 * makes keeps: its address proven only where it is Google's (`emailVerified`), so that GitHub or single sign-on
 * cannot link into an account Google made at an address Google merely knows.
 */
import type { OidcDefinition } from './oidc';

/** Google's identifier in the library's tables: `accounts.provider_id`. */
export const GOOGLE_PROVIDER_ID = 'google';

/** The domains whose every address is Google's own: consumer Gmail, under both its names. */
const GOOGLE_MAIL_DOMAINS: ReadonlySet<string> = new Set(['gmail.com', 'googlemail.com']);

/**
 * Google, as the OIDC core takes a provider. The issuer is an argument so a test points it at a stub; the
 * sign-in passes `GOOGLE_ISSUER` (`@purlay/types`).
 */
export const googleDefinition = (
  issuer: string,
  admit: OidcDefinition['admit'],
): OidcDefinition => ({
  id: GOOGLE_PROVIDER_ID,
  acceptedIssuers: [issuer, issuer.replace(/^https:\/\//u, '')],
  accountKey: (_issuer, subject) => subject,
  codes: { unavailable: 'GOOGLE_UNAVAILABLE', unverified: 'GOOGLE_EMAIL_UNVERIFIED' },
  messages: {
    unavailable: 'Google did not answer the sign-in.',
    unverified: 'Google did not say the address is verified.',
  },
  logPrefix: 'google sign-in',
  // An account Google makes keeps its address as proven only where Google speaks for it, so nothing else links
  // into it by an address Google merely knows (D-250 §3); Google itself signs it in by the `sub` whatever it holds.
  emailVerified: (claims, email) => authoritativeForGoogle(email, claims['hd']),
  ...(admit === undefined ? {} : { admit }),
});

/**
 * Whether Google speaks for this address: its domain is Gmail's, or it is exactly the Workspace domain the
 * token's `hd` names (a subdomain is another domain). Case does not count; an `hd` that is not a non-empty
 * string is no `hd`.
 */
export const authoritativeForGoogle = (email: string, hd: unknown): boolean => {
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  if (GOOGLE_MAIL_DOMAINS.has(domain)) return true;
  return typeof hd === 'string' && hd !== '' && domain === hd.toLowerCase();
};
