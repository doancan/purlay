/**
 * Signing in by an email link over HTTP (D-138, as amended by D-179): validated, handed to
 * `modules/auth/magic-link.ts`, and answered. `POST /auth/email` is `202` whatever the address;
 * without a relay it is `503 EMAIL_SIGN_IN_UNAVAILABLE` — never a `202` that sends nothing (D-138 §6).
 */
import { EmailSignInRequest, EmailSignInToken, type EmailSignInPreview } from '@purlay/types';
import {
  consumeSignInLink,
  previewSignInLink,
  requestSignInLink,
  type SignInLinkDependencies,
} from '../../modules/auth/magic-link';
import { CLIENT_ADDRESS_HEADER } from '../../modules/auth/better-auth';
import { validated } from './validate';

/** `POST /auth/email` — a link asked for; `client` is the asker's address as the edge keys it. */
export const askForSignInLink = async (
  dependencies: SignInLinkDependencies,
  body: unknown,
  client: string,
): Promise<void> => {
  await requestSignInLink(dependencies, validated(EmailSignInRequest, body), client);
};

/** `POST /auth/email/preview` — the address a link was sent to, shown before it is used. */
export const previewSignIn = async (
  dependencies: Pick<SignInLinkDependencies, 'database' | 'clock' | 'links'>,
  body: unknown,
): Promise<EmailSignInPreview> =>
  await previewSignInLink(dependencies, validated(EmailSignInToken, body).token);

/**
 * `POST /auth/email/consume` — the link spent and a session opened. Answers the session's cookie and
 * nothing else; the session keeps the address and the browser this server decided on.
 */
export const consumeSignIn = async (
  dependencies: Pick<SignInLinkDependencies, 'database' | 'clock' | 'links'>,
  body: unknown,
  meta: { readonly userAgent?: string | undefined; readonly ipAddress?: string | undefined },
): Promise<{ readonly setCookie: readonly string[] }> => {
  const { token } = validated(EmailSignInToken, body);
  const headers = new Headers();
  if (meta.userAgent !== undefined) headers.set('user-agent', meta.userAgent);
  if (meta.ipAddress !== undefined) headers.set(CLIENT_ADDRESS_HEADER, meta.ipAddress);
  return await consumeSignInLink(dependencies, token, headers);
};
