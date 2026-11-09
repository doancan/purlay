/**
 * The only place a handler's decision becomes a framework response.
 *
 * The handlers in `auth.ts` and `setup.ts` know nothing about the framework, so this is where a cookie, a redirect, a
 * status and a body are applied — once, rather than at every route.
 */
import type { HTTPHeaders } from 'elysia';
import type { AuthResponse } from './auth';
import type { SetupAnswer } from './setup';

/** A sign-in handler's answer, applied: its cookies, and either `204` or a redirect. */
export const respond = (
  set: { status?: number | string; headers: HTTPHeaders },
  result: AuthResponse,
): string => {
  set.headers['set-cookie'] = [...result.setCookie];
  if (result.location === undefined) {
    set.status = 204;
    return '';
  }
  set.status = 302;
  set.headers.location = result.location;
  return '';
};

/** A setup route's answer, applied: its status, its cookies, its body. */
export const answerSetup = <T>(
  set: { status?: number | string; headers: HTTPHeaders },
  answer: SetupAnswer<T>,
): T | string => {
  set.status = answer.status;
  if (answer.setCookie.length > 0) set.headers['set-cookie'] = [...answer.setCookie];
  return answer.status === 204 ? '' : answer.body;
};
