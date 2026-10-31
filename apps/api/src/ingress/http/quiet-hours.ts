/** `GET` and `PUT /api/me/quiet-hours` (D-234): the caller's own quiet hours, read on their profile's clock. */
import type { Executor } from '@purlay/db';
import { SetQuietHoursRequest, type QuietHoursSetting } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import { readQuietHours, setQuietHours } from '../../modules/users/quiet-hours';
import { requireSession } from './session';
import { validated } from './validate';

export interface QuietHoursDependencies {
  readonly auth: Auth;
  readonly database: Executor;
}

export const readMyQuietHours = async (
  dependencies: QuietHoursDependencies,
  request: Request,
): Promise<QuietHoursSetting> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await readQuietHours(dependencies.database, userId);
};

export const setMyQuietHours = async (
  dependencies: QuietHoursDependencies,
  request: Request,
  body: unknown,
): Promise<QuietHoursSetting> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await setQuietHours(dependencies.database, userId, validated(SetQuietHoursRequest, body));
};
