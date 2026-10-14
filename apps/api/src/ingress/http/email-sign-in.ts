/**
 * `POST /auth/email` — a sign-in link to an address (#81, D-138): `202` whatever the address, the
 * message made in the request's transaction and sent after the answer. Off without mail configured,
 * said as `503 EMAIL_SIGN_IN_UNAVAILABLE` — never a `202` that sends nothing (D-138 §6).
 */
import { EmailSignInRequest, EmailSignInToken, type EmailSignInPreview } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { Outbox } from '../../platform/mail';
import { atomicallyOn } from '../../platform/transactions';
import {
  consumeSignInLink,
  previewSignInLink,
  requestSignInLink,
} from '../../modules/auth/email-sign-in';
import { issueSession } from '../../modules/auth/sessions';
import { sessionCookie } from '../../platform/cookies';
import type { RateBudget, RateLimiter } from '../../realtime/rate-limiter';
import { validated } from './validate';

/**
 * How many links one client address may ask for in an hour, whatever the addresses (D-138 §7,
 * provisional, O-4): the per-address limit stops one mailbox being flooded, this stops one client
 * sending to many. Past it the answer is the same `202`, and nothing is made or sent.
 */
export const SIGN_IN_REQUESTS_PER_HOUR = 20;
export const SIGN_IN_REQUEST_BUDGET: RateBudget = {
  perSecond: SIGN_IN_REQUESTS_PER_HOUR / 3600,
  burst: SIGN_IN_REQUESTS_PER_HOUR,
};

export interface EmailSignInDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly config: Pick<Config, 'APP_URL' | 'SESSION_TTL_DAYS'>;
  readonly log: Logger;
  /** Absent where email sign-in is off. */
  readonly mail?: Outbox;
}

export const askForSignInLink = async (
  { database, clock, config, log, mail }: EmailSignInDependencies,
  body: unknown,
  client: { readonly address: string; readonly requests: RateLimiter },
): Promise<void> => {
  if (mail === undefined) {
    throw new AppError({
      code: 'EMAIL_SIGN_IN_UNAVAILABLE',
      message: 'This server does not sign in by email. Sign in with GitHub.',
    });
  }
  const input = validated(EmailSignInRequest, body);
  if (!(await client.requests.consume(client.address))) {
    log.warn('sign-in link refused: the client has asked for its links for the hour');
    return;
  }
  const message = await atomicallyOn(database)(
    async (transaction) =>
      await requestSignInLink(transaction, { clock, appUrl: config.APP_URL, log }, input),
  );
  if (message !== null) mail.post(message, 'sign-in');
};

/** `POST /auth/email/preview` — the address a link was sent to, shown before it is used. */
export const previewSignIn = async (
  { database, clock }: Pick<EmailSignInDependencies, 'database' | 'clock'>,
  body: unknown,
): Promise<EmailSignInPreview> => {
  const { token } = validated(EmailSignInToken, body);
  return await previewSignInLink(database, clock, token);
};

/**
 * `POST /auth/email/consume` — the link spent and a session opened, in one transaction: a failure
 * after the spend leaves the link unspent, to try again. Answers the session's cookie and nothing else.
 */
export const consumeSignIn = async (
  { database, clock, config }: Pick<EmailSignInDependencies, 'database' | 'clock' | 'config'>,
  body: unknown,
  meta: { readonly userAgent?: string | undefined; readonly ipAddress?: string | undefined },
): Promise<{ readonly setCookie: readonly string[] }> => {
  const { token } = validated(EmailSignInToken, body);
  const session = await atomicallyOn(database)(async (transaction) => {
    const { userId } = await consumeSignInLink(transaction, clock, token);
    return await issueSession(transaction, clock, userId, config.SESSION_TTL_DAYS, meta);
  });
  return { setCookie: [sessionCookie(session)] };
};
