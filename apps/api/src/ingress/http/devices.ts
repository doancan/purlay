/** Where the caller is signed in, and ending one place (D-193). */
import type { Executor } from '@purlay/db';
import { Uuid, type DeviceSessionList } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import {
  publishAfterCommit,
  publication,
  publishSessionsEnded,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Auth } from '../../modules/auth/better-auth';
import { deviceSessions, endDeviceSession } from '../../modules/auth/devices';
import { requireSession } from './session';
import { validated } from './validate';

export interface DeviceDependencies {
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly bus: EventBus;
}

/** `GET /api/me/sessions` — the caller's own live sessions, the one used last first. */
export const readMySessions = async (
  dependencies: DeviceDependencies,
  request: Request,
): Promise<DeviceSessionList> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  return {
    data: [
      ...(await deviceSessions(
        dependencies.database,
        userId,
        sessionId,
        dependencies.auth.sessionLifetime,
      )),
    ],
  };
};

/**
 * `DELETE /api/me/sessions/:sessionId` — ends one of the caller's sessions; `204`. The sockets it held are told
 * after the delete is committed, so none is closed for an end that did not happen (D-85, #194).
 */
export const endMySession = async (
  dependencies: DeviceDependencies,
  request: Request,
  sessionId: string,
): Promise<void> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const id = validated(Uuid, sessionId);
  const ended = await endDeviceSession(dependencies.database, userId, id);
  await publishAfterCommit(dependencies.log, [
    [
      publication('SESSION_ENDED', () =>
        publishSessionsEnded(dependencies.bus, dependencies.clock, [ended]),
      ),
    ],
  ]);
};
