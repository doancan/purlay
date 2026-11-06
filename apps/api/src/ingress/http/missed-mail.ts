/**
 * Email about what a person missed (D-240), over HTTP: the caller's own setting, read and set with their
 * session. These two routes are the core's (`CORE_ROUTES`) and call chat's service, so this file is a door that
 * imports chat; the letter's stop link is chat's own and is in `features/chat/http/missed-mail.ts` (D-280).
 * Whether the server can send mail is whether the sign-in library has a relay to send through, read per
 * request, so a relay added in the settings counts at once.
 */
import type { Executor } from '@purlay/db';
import { SetMissedMailRequest, type MissedMailSetting } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import { readMissedMail, setMissedMail } from '../../features/chat/notifications/missed-mail';
import type { Clock } from '../../platform/clock';
import { requireSession } from './session';
import { validated } from './validate';

export interface MissedMailRouteDependencies {
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
}

const mailOn = (auth: Auth): boolean => auth.signInLinks !== undefined;

export const readMyMissedMail = async (
  dependencies: MissedMailRouteDependencies,
  request: Request,
): Promise<MissedMailSetting> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await readMissedMail(dependencies.database, userId, mailOn(dependencies.auth));
};

export const setMyMissedMail = async (
  dependencies: MissedMailRouteDependencies,
  request: Request,
  body: unknown,
): Promise<MissedMailSetting> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await setMissedMail(
    dependencies.database,
    dependencies.clock,
    userId,
    validated(SetMissedMailRequest, body),
    mailOn(dependencies.auth),
  );
};
