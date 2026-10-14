/**
 * `POST /auth/email` — a sign-in link to an address (#81, D-138): `202` whatever the address, the
 * message made in the request's transaction and sent after the answer. Off without mail configured,
 * said as `503 EMAIL_SIGN_IN_UNAVAILABLE` — never a `202` that sends nothing (D-138 §6).
 */
import { EmailSignInRequest } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { Outbox } from '../../platform/mail';
import { atomicallyOn } from '../../platform/transactions';
import { requestSignInLink } from '../../modules/auth/email-sign-in';
import { validated } from './validate';

export interface EmailSignInDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly config: Pick<Config, 'APP_URL'>;
  readonly log: Logger;
  /** Absent where email sign-in is off. */
  readonly mail?: Outbox;
}

export const askForSignInLink = async (
  { database, clock, config, log, mail }: EmailSignInDependencies,
  body: unknown,
): Promise<void> => {
  if (mail === undefined) {
    throw new AppError({
      code: 'EMAIL_SIGN_IN_UNAVAILABLE',
      message: 'This server does not sign in by email. Sign in with GitHub.',
    });
  }
  const input = validated(EmailSignInRequest, body);
  const message = await atomicallyOn(database)(
    async (transaction) =>
      await requestSignInLink(transaction, { clock, appUrl: config.APP_URL, log }, input),
  );
  if (message !== null) mail.post(message, 'sign-in');
};
