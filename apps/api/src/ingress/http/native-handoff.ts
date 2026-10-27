/**
 * The two doors of the native sign-in handoff over HTTP (D-191, `API.md` §2): validated, handed to
 * `modules/auth/native-handoff.ts`, and answered.
 *
 * `authorize` is called by the browser's own page once the person, signed in, has said yes: it needs
 * the session and, being a `POST`, the edge's `Origin` rule has already refused every other site. `token`
 * is called by the application, which has no session yet — that is what it is for — so it is public, and
 * is charged to the client's address before the code is looked at (`rate-limit.ts`).
 */
import type { Executor } from '@purlay/db';
import {
  NATIVE_REDIRECT,
  NativeAuthorizeRequest,
  NativeTokenRequest,
  type NativeAuthorizeResponse,
} from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import { deriveAuthSecret } from '../../modules/auth/better-auth';
import { authorizeNative, exchangeNativeCode } from '../../modules/auth/native-handoff';
import type { Logger } from '../../platform/logging';
import { SESSION_CLOCK } from '../../modules/auth/sessions';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { sessionCookie } from '../../platform/cookies';
import { AppError } from '../../platform/errors';
import { parseClientHeader } from './client-policy';
import { requireSession } from './session';
import { validated } from './validate';
import type { AuthResponse } from './auth';

export interface NativeHandoffDependencies {
  readonly auth: Auth;
  readonly config: Config;
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
}

/**
 * `POST /api/native/authorize` — a code for the person who is signed in, and where to send the browser
 * with it. The address is this server's own and fixed (`NATIVE_REDIRECT`): the client names none.
 */
export const authorizeNativeClient = async (
  dependencies: NativeHandoffDependencies,
  request: Request,
  body: unknown,
): Promise<NativeAuthorizeResponse> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const { challenge, state } = validated(NativeAuthorizeRequest, body);
  const { code } = await authorizeNative(dependencies.database, dependencies.clock, {
    userId,
    challenge,
  });
  // Every character of `code` is hex and of `state` base64url (the contract's patterns), so nothing here
  // can end a parameter or begin another.
  return { redirect: `${NATIVE_REDIRECT}?code=${code}&state=${state}` };
};

/**
 * What a session made this way says about itself, for whoever reads the sessions: the application and its
 * version — read from the header it says it in, and only if that is the shape — and the device's name,
 * trimmed. A header that is not the shape is "unknown", never copied.
 */
const sessionLabel = (clientHeader: string | null, deviceName: string): string => {
  const client = parseClientHeader(clientHeader);
  const version = client?.platform === 'macos' ? client.version : 'unknown';
  return `Purlay for macOS/${version} (${deviceName})`;
};

/**
 * `POST /api/native/token` — the code spent for a session, as the cookie the application keeps, or
 * `404 NATIVE_CODE_NOT_FOUND`, which is the same whichever way the code failed.
 */
export const exchangeNativeToken = async (
  dependencies: NativeHandoffDependencies,
  body: unknown,
  meta: { readonly clientHeader: string | null; readonly ipAddress: string | undefined },
): Promise<AuthResponse> => {
  const { code, verifier, device } = validated(NativeTokenRequest, body);
  const name = device.name.trim();
  if (name === '') {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: { 'device/name': 'must name the device' } },
    });
  }
  const minted = await exchangeNativeCode(
    dependencies.database,
    dependencies.clock,
    {
      secret: deriveAuthSecret(dependencies.config.ENCRYPTION_KEY),
      sessionTtlDays: dependencies.config.SESSION_TTL_DAYS,
    },
    {
      code,
      verifier,
      userAgent: sessionLabel(meta.clientHeader, name),
      deviceName: name,
      ipAddress: meta.ipAddress,
      // Why, for whoever reads the log; never the code, the verifier or the person. A guess is a warning, a code that
      // simply does not exist is not one: every typo and every stale link would be.
      refused: (reason) => {
        const line = `native sign-in code refused: ${reason}`;
        if (reason === 'wrong-verifier' || reason === 'burnt') dependencies.log.warn(line);
        else dependencies.log.info(line);
      },
    },
  );
  if (minted === undefined) {
    throw new AppError({
      code: 'NATIVE_CODE_NOT_FOUND',
      message: 'That sign-in code does not open. Start again from the application.',
    });
  }
  // The session's expiry is made from the wall clock, so the cookie's lifetime is read against it.
  const seconds = Math.floor((minted.expiresAt.getTime() - SESSION_CLOCK.now().getTime()) / 1000);
  return { setCookie: [sessionCookie(minted.token, Math.max(0, seconds))] };
};
