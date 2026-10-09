/**
 * Who is allowed to open a socket, decided before one is bound.
 *
 * Both checks happen here, in this order, and neither is optional.
 *
 * **1 · `Origin` must be `APP_URL`.** `SameSite=Lax` does not reliably protect a
 * WebSocket handshake: a page on another origin can open `wss://…/ws` and the
 * browser may attach the cookie. That is cross-site WebSocket hijacking, and the
 * check runs **before the session is even looked up** (D-39). One origin makes it
 * an equality rather than a list (D-61).
 *
 * **2 · The session is validated before the socket is bound**, never after
 * (`ARCHITECTURE.md` §7.2). A socket that is bound and then checked has already
 * been handed a channel to write into.
 *
 * There is no token-in-query-string path: query strings land in access logs.
 *
 * Framework-neutral on purpose — the decision is testable without a server, and
 * a refusal is a real HTTP status rather than a socket that closes for reasons
 * the client has to guess at.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { AppError } from '../platform/errors';
import { isAppOrigin } from '../platform/origin';
import { resolveSession } from '../modules/auth/sessions';
import { sessionTokenFrom } from '../ingress/http/cookies';

export interface UpgradeDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly appUrl: string;
}

export interface AdmittedSocket {
  readonly userId: string;
}

/**
 * Returns who is connecting, or throws the refusal the handshake answers with.
 *
 * A missing `Origin` is refused too: a browser always sends one on a
 * cross-origin-capable request, so its absence is not a browser following the
 * rules.
 */
export const admitSocket = async (
  dependencies: UpgradeDependencies,
  request: Request,
): Promise<AdmittedSocket> => {
  const origin = request.headers.get('origin');
  if (!isAppOrigin(origin, dependencies.appUrl)) {
    throw new AppError({ code: 'FORBIDDEN', message: 'That origin may not open a socket here.' });
  }

  const token = sessionTokenFrom(request.headers.get('cookie'));
  const owner =
    token === undefined
      ? undefined
      : await resolveSession(dependencies.database, dependencies.clock, token);
  if (owner === undefined) {
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  }

  return { userId: owner.userId };
};
