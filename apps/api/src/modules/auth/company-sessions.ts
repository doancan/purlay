/** Native sessions with an independently retained company origin and a credential old readers cannot accept (D-309). */
import { hkdfSync, timingSafeEqual } from 'node:crypto';
import { makeSignature } from 'better-auth/crypto';
import { sql, sessionTokenDigest, type Executor } from '@purlay/db';
import { liveCompanySessionProof } from '../../platform/company-session';
import { COMPANY_SESSION_COOKIE, SESSION_COOKIE, readCookie } from '../../platform/cookies';
import { systemClock } from '../../platform/clock';

export interface SessionAuthority {
  readonly companyWorkspaceId?: string;
}

/** Missing provenance after a purge invalidates the retained origin; it never restores independent authority. */
export const readSessionAuthority = async (
  database: Executor,
  sessionId: string,
  userId: string,
): Promise<SessionAuthority | undefined> => {
  const row = await database
    .selectFrom('sessions')
    .select('company_workspace_id')
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .where('expires_at', '>', systemClock.now())
    .executeTakeFirst();
  if (row === undefined) return undefined;
  // Origin is immutable after creation. Do not plan seven company joins for an independent session.
  if (row.company_workspace_id === null) return {};
  const current = await database
    .selectFrom('sessions')
    .select('id')
    .where('id', '=', sessionId)
    .where('user_id', '=', userId)
    .where('company_workspace_id', '=', row.company_workspace_id)
    .where('expires_at', '>', systemClock.now())
    .where(liveCompanySessionProof(sessionId, sql<string>`sessions.company_workspace_id`, userId))
    .executeTakeFirst();
  return current === undefined ? undefined : { companyWorkspaceId: row.company_workspace_id };
};

const valueOf = (
  encoded: string,
): { readonly token: string; readonly signature: string } | undefined => {
  if (encoded.length > 1024) return undefined;
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
  const dot = value.lastIndexOf('.');
  if (dot < 1 || dot === value.length - 1) return undefined;
  return { token: value.slice(0, dot), signature: value.slice(dot + 1) };
};

/** Cookie names and their MACs are separate boundaries: renaming alone cannot bypass an older reader. */
export const companySessionCookies = (
  database: Executor,
  secret: string,
): {
  readonly nativeHeaders: (headers: Headers) => Promise<Headers | undefined>;
  readonly independentHeaders: (headers: Headers) => Headers;
  readonly nativeCookieValue: (encoded: string) => Promise<string>;
  readonly publicResponse: (
    response: Response,
    companyPresented: boolean,
    independent?: boolean,
  ) => Promise<Response>;
} => {
  const companySecret = Buffer.from(
    hkdfSync('sha256', secret, '', 'company-session-cookie@purlay/v1', 32),
  ).toString('base64url');
  const directorySecret = Buffer.from(
    hkdfSync('sha256', secret, '', 'directory-session-cookie@purlay/v1', 32),
  ).toString('base64url');
  const sign = async (token: string, key: string): Promise<string> =>
    encodeURIComponent(`${token}.${await makeSignature(token, key)}`);
  const clear = (name: string): string =>
    `${name}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  const independentHeaders = (headers: Headers): Headers => {
    if (readCookie(headers.get('cookie'), COMPANY_SESSION_COOKIE) === undefined) return headers;
    const next = new Headers(headers);
    const remaining = (headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(
        (part) =>
          !part.startsWith(`${SESSION_COOKIE}=`) && !part.startsWith(`${COMPANY_SESSION_COOKIE}=`),
      );
    next.set('cookie', remaining.join('; '));
    return next;
  };
  const nativeHeaders = async (headers: Headers): Promise<Headers | undefined> => {
    const explicit = readCookie(headers.get('cookie'), COMPANY_SESSION_COOKIE);
    // Native clients persist the original cookie name; its separate MAC still rejects older readers.
    const presented = explicit ?? readCookie(headers.get('cookie'), SESSION_COOKIE);
    if (presented === undefined) return headers;
    const decoded = valueOf(presented);
    if (decoded === undefined) return explicit === undefined ? headers : undefined;
    const expected = Buffer.from(await makeSignature(decoded.token, companySecret));
    const directoryExpected = Buffer.from(await makeSignature(decoded.token, directorySecret));
    const actual = Buffer.from(decoded.signature);
    const companyValid = expected.length === actual.length && timingSafeEqual(expected, actual);
    const directoryValid =
      directoryExpected.length === actual.length && timingSafeEqual(directoryExpected, actual);
    if (!companyValid && !directoryValid) return explicit === undefined ? headers : undefined;
    const row = await database
      .selectFrom('sessions')
      .select(['id', 'directory_id'])
      .where('token_hash', '=', sessionTokenDigest(decoded.token))
      .where('company_workspace_id', 'is not', null)
      .executeTakeFirst();
    if (row === undefined || (row.directory_id === null ? !companyValid : !directoryValid))
      return undefined;
    const next = new Headers(headers);
    const others = (headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter((part) => !part.startsWith(`${SESSION_COOKIE}=`));
    // Native uses the original cookie name, but library credential guards still require the
    // authenticated company marker after translating its MAC for the private SDK call.
    if (explicit === undefined) others.push(`${COMPANY_SESSION_COOKIE}=${presented}`);
    next.set(
      'cookie',
      [...others, `${SESSION_COOKIE}=${await sign(decoded.token, secret)}`].join('; '),
    );
    return next;
  };
  const publicResponse = async (
    response: Response,
    companyPresented: boolean,
    independent = false,
  ): Promise<Response> => {
    const original = response.headers.getSetCookie();
    if (!original.some((line) => line.startsWith(`${SESSION_COOKIE}=`))) return response;
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    for (const line of original) {
      if (!line.startsWith(`${SESSION_COOKIE}=`)) {
        headers.append('set-cookie', line);
        continue;
      }
      const first = line.split(';')[0] ?? '';
      const encoded = first.slice(SESSION_COOKIE.length + 1);
      const decoded = valueOf(encoded);
      if (decoded === undefined) {
        headers.append('set-cookie', line);
        // A password's second-step challenge clears the ordinary cookie before proof is complete.
        if (companyPresented && !independent)
          headers.append('set-cookie', clear(COMPANY_SESSION_COOKIE));
        continue;
      }
      const row = await database
        .selectFrom('sessions')
        .select(['company_workspace_id', 'directory_id'])
        .where('token_hash', '=', sessionTokenDigest(decoded.token))
        .executeTakeFirst();
      if (row !== undefined && row.company_workspace_id !== null) {
        headers.append(
          'set-cookie',
          `${COMPANY_SESSION_COOKIE}=${await sign(decoded.token, row.directory_id === null ? companySecret : directorySecret)}${line.slice(first.length)}`,
        );
        headers.append('set-cookie', clear(SESSION_COOKIE));
      } else {
        headers.append('set-cookie', line);
        if (companyPresented) headers.append('set-cookie', clear(COMPANY_SESSION_COOKIE));
      }
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  const nativeCookieValue = async (encoded: string): Promise<string> => {
    const decoded = valueOf(encoded);
    if (decoded === undefined) throw new Error('Expected a signed native session value');
    const row = await database
      .selectFrom('sessions')
      .select(['company_workspace_id', 'directory_id'])
      .where('token_hash', '=', sessionTokenDigest(decoded.token))
      .executeTakeFirst();
    if (row?.company_workspace_id == null)
      throw new Error('Expected a retained native company origin');
    return await sign(decoded.token, row.directory_id === null ? companySecret : directorySecret);
  };
  return { nativeHeaders, independentHeaders, publicResponse, nativeCookieValue };
};
