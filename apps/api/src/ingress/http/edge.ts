/**
 * What is bounded before a handler runs: the body, the origin, the response's
 * own headers and the label a request carries.
 *
 * Kept out of `app.ts` because none of it is a route — it is the same four
 * decisions for every route — and because a decision made in one place cannot
 * be forgotten by the next endpoint (#234, D-39 item 2).
 */
import { MAX_FRAME_BYTES } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { isAppOrigin } from '../../platform/origin';
import { refusalFor } from './errors';

/**
 * The largest JSON body any endpoint accepts, in bytes. **The one home of the
 * number**, and it is the socket's frame: a message posted over HTTP is the same
 * message the socket would carry, so the same bytes bound it (D-67). Every other
 * body — a workspace, a channel — is a few hundred. An attachment is not JSON
 * and will not come through here; when its route lands it raises this server
 * cap and holds the JSON routes to this number itself.
 *
 * Enforced by the server, per request, from `Content-Length` and while a
 * chunked body streams — so an oversized body is refused **before it is
 * buffered or parsed**, which a check in a handler cannot do. Measured on Bun
 * 1.4: a 60 MB body answered 200 after 27 ms with no limit, and 413 after 2 ms
 * with this one, neither request hook having run (D-80).
 */
export const JSON_BODY_MAX_BYTES = MAX_FRAME_BYTES;

const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Whether a state-changing request must be refused as cross-site (D-39 item 2).
 *
 * `Origin` present: it must be the application's. Absent: the browser says in
 * `Sec-Fetch-Site` whether the request is its own — only `same-origin` and
 * `none` (a typed address, a bookmark) are. Neither header: not a browser. CSRF
 * needs one, because the cookie is ambient only in a browser, and every browser
 * that can send a cross-site `POST` sends `Origin` on it — so there is nothing
 * to forge, and refusing would only break `curl` and the test clients.
 *
 * When both are present both must hold: a stale `Origin` does not excuse a
 * cross-site fetch.
 */
export const isCrossSiteMutation = (request: Request, appUrl: string): boolean => {
  if (!STATE_CHANGING.has(request.method)) return false;
  const origin = request.headers.get('origin');
  if (origin !== null && !isAppOrigin(origin, appUrl)) return true;
  const site = request.headers.get('sec-fetch-site');
  return site !== null && site !== 'same-origin' && site !== 'none';
};

/**
 * Whether a state-changing request carries a body that is not JSON (D-39 item 2).
 *
 * The defence against a cross-site form is that every mutation takes
 * `application/json`, which a form cannot send. That is only true if something
 * refuses the types a form *can* send — `application/x-www-form-urlencoded`,
 * `multipart/form-data`, `text/plain` — and nothing did: with neither `Origin`
 * nor `Sec-Fetch-Site`, such a post created a workspace. A type that is present
 * must be JSON; a body with no type is refused too. A request with neither a
 * type nor a body (logout, join) is not a body, and passes.
 */
export const hasUnsupportedMediaType = (request: Request): boolean => {
  if (!STATE_CHANGING.has(request.method)) return false;
  const type = request.headers.get('content-type');
  if (type !== null) return type.split(';')[0]?.trim().toLowerCase() !== 'application/json';
  return request.body !== null && request.headers.get('content-length') !== '0';
};

/**
 * Whether a state-changing request's body may be read at all, judged by its `Content-Length`
 * before a byte of it is (D-80, D-109 §4).
 *
 * The server's own limit is what an upload needs, so it no longer bounds a JSON body: this does.
 * On the wire a body has a `Content-Length` or is chunked (HTTP/1.1, which is what the proxy speaks
 * to us). A chunked body is refused outright, because its size cannot be known until it has been
 * read, and reading it is the cost the limit exists to avoid; one with a length is held to it. A
 * request with neither has no body to judge (logout, join — and a request built in-process).
 */
export const bodyRefusal = (request: Request, limit: number): AppError | null => {
  if (!STATE_CHANGING.has(request.method)) return null;
  const chunked = /\bchunked\b/i.test(request.headers.get('transfer-encoding') ?? '');
  const header = request.headers.get('content-length');
  if (chunked) {
    return new AppError({
      code: 'LENGTH_REQUIRED',
      message: 'A request body needs a Content-Length.',
    });
  }
  if (header === null) return null;
  const length = Number(header);
  if (!Number.isSafeInteger(length) || length > limit) {
    return new AppError({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request body is larger than this route takes.',
    });
  }
  return null;
};

/** A refusal the edge decided, in the API's own error shape. */
export const edgeRefusalResponse = (error: AppError, headers: Record<string, string>): Response =>
  refused(error, headers);

/**
 * Headers every response carries, decided once from `APP_URL`.
 *
 * - `nosniff`: a JSON body is never reinterpreted as script or markup.
 * - `Referrer-Policy: no-referrer`: no URL (a channel id, an OAuth `code`) leaves.
 * - CSP `default-src 'none'; frame-ancestors 'none'`: an API response is data;
 *   nothing it contains may load, and nothing may frame it. The baseline for
 *   user-authored markup is D-39 item 5, and it is the web app's.
 * - `Cache-Control: no-store`: a shared cache must not keep a session's JSON.
 * - HSTS only when the origin is https — over http it is ignored by browsers and
 *   a promise this deployment cannot keep. Six months, **without**
 *   `includeSubDomains`: a self-hoster's apex may serve something that cannot
 *   afford it.
 */
export const responseHeaders = (appUrl: string): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cache-control': 'no-store',
  ...(appUrl.startsWith('https://') ? { 'strict-transport-security': 'max-age=15552000' } : {}),
});

/**
 * The policy of the client's HTML document (D-102), which replaces the API's on that one
 * response: an API answer loads nothing, a document loads the client from its own origin.
 *
 * No inline script and no `eval`: the build emits files, and `theme-init.js` is one so it
 * needs no hash. Two exceptions, each D-102's: inline **style**, because the dialog
 * primitive's scroll lock writes a `<style>` element (D-52), and GitHub's avatar host,
 * until avatars come through the image proxy. `connect-src 'self'` covers the socket, a
 * same-origin `wss:` under CSP Level 3.
 */
const DOCUMENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // TODO(#110): 'self' alone once avatars are served through the image proxy.
  "img-src 'self' https://avatars.githubusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** What the document carries in place of the API's policy (D-102). */
export const DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': DOCUMENT_SECURITY_POLICY,
  // Sign-in is a top-level navigation, never a pop-up: nothing it opens needs a handle back.
  'cross-origin-opener-policy': 'same-origin',
};

/** Bounded in length and in alphabet: it is written into logs and echoed in a header. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The id this request is known by. A well-formed one from the edge is kept so a
 * trace can be followed across the proxy and the API; it is a **label**, never
 * a credential or an identity, and nothing is authorised by it. Anything else
 * is replaced rather than cleaned.
 */
export const inboundRequestId = (headers: Headers): string => {
  const header = headers.get('x-request-id');
  return header !== null && REQUEST_ID.test(header) ? header : crypto.randomUUID();
};

/** A refusal made at the edge, as a response the framework need not shape. */
const refused = (error: AppError, headers: Record<string, string>): Response => {
  const refusal = refusalFor(error.body.code, error, []);
  return Response.json(refusal.body, { status: refusal.status, headers });
};

export const crossSiteResponse = (headers: Record<string, string>): Response =>
  refused(
    new AppError({ code: 'FORBIDDEN', message: 'That origin may not make this request.' }),
    headers,
  );

export const unsupportedMediaTypeResponse = (headers: Record<string, string>): Response =>
  refused(
    new AppError({
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'A request body must be application/json.',
    }),
    headers,
  );
