/**
 * Email about what a person missed (D-240), over HTTP: the caller's own setting, read and set with their
 * session, and the letter's stop link, which needs none — the token in its body is the proof, and the route is
 * charged to the client's address before it is looked at (`rate-limit.ts`). Whether the server can send mail
 * is whether the sign-in library has a relay to send through, read per request, so a relay added in the
 * settings counts at once.
 */
import type { Executor } from '@purlay/db';
import { SetMissedMailRequest, StopMissedMailRequest, type MissedMailSetting } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import {
  readMissedMail,
  setMissedMail,
  stopMissedMail,
} from '../../modules/notifications/missed-mail';
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

/** `POST /api/missed-mail/stop` — public: `204`, or one `404` for every link that does not open. */
export const stopMissedMailByLink = async (
  dependencies: MissedMailRouteDependencies,
  body: unknown,
): Promise<void> => {
  await stopMissedMail(
    dependencies.database,
    dependencies.clock,
    validated(StopMissedMailRequest, body),
  );
};
