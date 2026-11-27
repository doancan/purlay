/**
 * The built client, after every route of the API's own: a path the API owns is never answered with HTML, so a mistyped call
 * fails as the API's 404 at the call, not as a parse error somewhere else.
 */
import { AppError } from '../../../platform/errors';
import { DOCUMENT_HEADERS, WORKER_HEADERS } from '../edge';
import { clientFileFor, isUnchanged, SHELL_MISSING } from '../client';
import { Elysia, type AnyElysia } from 'elysia';
import type { RouteContext } from '../route-context';

/** Seconds a browser waits before asking for a page again while the build is being replaced. */
const RELOAD_AFTER_SECONDS = 2;

/**
 * The page a navigation gets while the build is being replaced: a document, so the browser shows
 * it instead of the API's error envelope, that asks again by itself without running a script.
 */
const UPDATING_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${String(RELOAD_AFTER_SECONDS)}">
<title>Updating</title>
</head>
<body>
<p>Updating. This page reloads in a moment.</p>
</body>
</html>
`;

export const clientRoutes = (context: RouteContext): AnyElysia => {
  const { dependencies } = context;

  return new Elysia().get('*', async ({ path, request, set }) => {
    const notFound = new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
    const updating = (): string => {
      dependencies.log.warn('the client has no shell; answering that it is updating', { path });
      set.status = 503;
      Object.assign(set.headers, DOCUMENT_HEADERS);
      set.headers['content-type'] = 'text/html; charset=utf-8';
      set.headers['cache-control'] = 'no-store';
      set.headers['retry-after'] = String(RELOAD_AFTER_SECONDS);
      return UPDATING_PAGE;
    };
    // `clientFileFor` decides whose the path is, read decoded: one place, so `/%61pi` and
    // `/api` cannot be judged twice and differently.
    const file =
      dependencies.client === undefined ? undefined : clientFileFor(dependencies.client, path);
    if (file === undefined) throw notFound;
    if (file === SHELL_MISSING) return updating();
    set.headers['cache-control'] = file.cacheControl;
    set.headers.etag = file.etag;
    if (file.document) Object.assign(set.headers, DOCUMENT_HEADERS);
    if (file.worker) Object.assign(set.headers, WORKER_HEADERS);
    // The browser already has this version: nothing to send (RFC 9110 §13.1.2).
    if (isUnchanged(request.headers.get('if-none-match'), file.etag)) {
      set.status = 304;
      return null;
    }
    // Opened here, so a file gone since it was found is this handler's 404 and not the
    // runtime's own error page, which the one error handler never sees.
    const body = Bun.file(file.path);
    if (!(await body.exists())) {
      if (file.document) {
        // Its version was named for the shell that went; the page that replaces it has none.
        delete set.headers.etag;
        return updating();
      }
      throw notFound;
    }
    return body;
  });
};
