/**
 * `PUT /api/me/away` (D-257): the caller appears away, by choice, or stops. The column is written first, then
 * the person's state is told again at a new version through the one announcement path presence has, so a
 * co-member's next frame already carries it. Offline, nothing is told: the choice waits for their next arrival.
 * The person's own state: no audit entry.
 */
import type { Executor } from '@purlay/db';
import { SetAwayRequest, type SetAwayResponse } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import { setAwayChoice } from '../../modules/users/away';
import type { OnlinePresence } from '../../realtime/online';
import { requireSession } from './session';
import { validated } from './validate';

export interface AwayDependencies {
  readonly auth: Auth;
  readonly database: Executor;
}

export const setMyAway = async (
  dependencies: AwayDependencies,
  online: Pick<OnlinePresence, 'retell'>,
  request: Request,
  body: unknown,
): Promise<SetAwayResponse> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const { away } = validated(SetAwayRequest, body);
  await setAwayChoice(dependencies.database, userId, away);
  await online.retell(userId);
  return { away };
};
