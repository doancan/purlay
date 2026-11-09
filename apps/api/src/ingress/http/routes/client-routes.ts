/**
 * The built client, after every route of the API's own: a path the API owns is never answered with HTML, so a mistyped call
 * fails as the API's 404 at the call, not as a parse error somewhere else.
 */
import { AppError } from '../../../platform/errors';
import { DOCUMENT_HEADERS, WORKER_HEADERS } from '../edge';
import { clientFileFor, isUnchanged } from '../client';
import { Elysia, type AnyElysia } from 'elysia';
import type { RouteContext } from '../route-context';

export const clientRoutes = (context: RouteContext): AnyElysia => {
  const { dependencies } = context;

  return new Elysia().get('*', async ({ path, request, set }) => {
    const notFound = new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
    // `clientFileFor` decides whose the path is, read decoded: one place, so `/%61pi` and
    // `/api` cannot be judged twice and differently.
    const file =
      dependencies.client === undefined ? undefined : clientFileFor(dependencies.client, path);
    if (file === undefined) throw notFound;
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
    if (!(await body.exists())) throw notFound;
    return body;
  });
};
