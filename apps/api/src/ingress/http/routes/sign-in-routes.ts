/**
 * Signing in and out: the providers' start routes, the sign-in by link, the native application's hand-off,
 * what a client may ask before it has a session (`GET /api/auth/methods`, `GET /api/client`), and the sign-in library's own
 * routes under `AUTH_BASE_PATH`.
 */
import { askForSignInLink, consumeSignIn, previewSignIn } from '../magic-link';
import type { SignInLinkDependencies } from '../../../modules/auth/magic-link';
import { authMethods } from '../auth-methods';
import { clientInfo } from '../client-info';
import { authorizeNativeClient, exchangeNativeToken } from '../native-handoff';
import { answerAuth, signOut, signOutEverywhere, startSignIn } from '../auth';
import type { ModuleId } from '@purlay/types';
import { limitKeyFor } from '../../../platform/client-key';
import { clientAddress, peerOf, type PeerSource } from '../client-address';
import { Elysia, type AnyElysia } from 'elysia';
import type { RouteContext } from '../route-context';
import { respond } from '../route-answers';

export const signInRoutes = (
  context: RouteContext,
  later: SignInLinkDependencies['later'],
): AnyElysia => {
  const { dependencies, moduleIds, modules, sockets } = context;
  /** The same, less those the administrator has stopped at run time (D-296): what a client may draw. */
  const runningNow = (): readonly ModuleId[] =>
    moduleIds.filter((id) => !modules.suspension.current().has(id));
  // Sign-in by link: the library's, decided by Purlay's rules (`modules/auth/magic-link.ts`). Read
  // per request, so building the application asks nothing of the library.
  // What a request for a link comes to is decided after its answer (D-138 §1, §6).
  const signInLinks = (): SignInLinkDependencies => ({
    ...dependencies,
    appUrl: dependencies.config.APP_URL,
    links: dependencies.auth.signInLinks,
    later,
  });
  /** The library's answer to a request under its base path, with the client's address decided here. */
  const library = async (request: Request, server: PeerSource | null): Promise<Response> =>
    await answerAuth(
      dependencies,
      request,
      clientAddress(peerOf(server, request), request.headers, dependencies.config.TRUST_PROXY),
    );

  return (
    new Elysia()
      .get('/auth/github', async ({ set }) => respond(set, await startSignIn(dependencies)))
      .get('/auth/oidc', async ({ set }) => respond(set, await startSignIn(dependencies, 'oidc')))
      .get('/auth/google', async ({ set }) =>
        respond(set, await startSignIn(dependencies, 'google')),
      )
      .get('/api/auth/methods', () => authMethods(dependencies.auth))
      .get('/api/client', () => clientInfo(dependencies.config, dependencies.auth, runningNow()))
      // The native application's way in (D-191): the browser's page says yes, the application spends the code.
      .post(
        '/api/native/authorize',
        async ({ request, body }) => await authorizeNativeClient(dependencies, request, body),
      )
      .post('/api/native/token', async ({ request, body, set, server }) =>
        respond(
          set,
          await exchangeNativeToken(dependencies, body, {
            clientHeader: request.headers.get('x-purlay-client'),
            ipAddress: clientAddress(
              peerOf(server, request),
              request.headers,
              dependencies.config.TRUST_PROXY,
            ),
          }),
        ),
      )
      .post('/auth/email', async ({ request, body, set, server }) => {
        await askForSignInLink(
          signInLinks(),
          body,
          // Keyed as the edge's budget is: an IPv6 client by its /64 (`limitKeyFor`).
          limitKeyFor(
            clientAddress(
              peerOf(server, request),
              request.headers,
              dependencies.config.TRUST_PROXY,
            ),
          ),
        );
        set.status = 202;
        return null;
      })
      .post('/auth/email/preview', async ({ body }) => await previewSignIn(signInLinks(), body))
      .post('/auth/email/consume', async ({ request, body, set, server }) =>
        respond(
          set,
          await consumeSignIn(signInLinks(), body, {
            userAgent: request.headers.get('user-agent') ?? undefined,
            ipAddress: clientAddress(
              peerOf(server, request),
              request.headers,
              dependencies.config.TRUST_PROXY,
            ),
          }),
        ),
      )
      // The sign-in library's own routes (D-179), which answer only GET and POST: everything under its
      // base path (`AUTH_BASE_PATH`) that no route of ours answers — a static route wins over these
      // whatever the order. Not `.mount`: it strips the prefix the library is configured to expect,
      // and a route registered for every method loses to `GET *` below, the client's (measured on
      // Elysia 1.4.30). The body is left unread for the library, as `.mount` would leave it. Its
      // GitHub callback is `SIGN_IN_CALLBACK`: a failure thrown there reaches the error hook's
      // redirect above, never JSON (D-121).
      .get('/auth/*', async ({ request, server }) => await library(request, server), {
        parse: 'none',
      })
      .post('/auth/*', async ({ request, server }) => await library(request, server), {
        parse: 'none',
      })
      // Only native SCIM resources add protocol mutation verbs; the remaining auth surface stays closed.
      .put(
        '/auth/scim/v2/Users/:resourceId',
        async ({ request, server }) => await library(request, server),
        { parse: 'none' },
      )
      .put(
        '/auth/scim/v2/Groups/:resourceId',
        async ({ request, server }) => await library(request, server),
        { parse: 'none' },
      )
      .patch(
        '/auth/scim/v2/Users/:resourceId',
        async ({ request, server }) => await library(request, server),
        { parse: 'none' },
      )
      .patch(
        '/auth/scim/v2/Groups/:resourceId',
        async ({ request, server }) => await library(request, server),
        { parse: 'none' },
      )
      .delete(
        '/auth/scim/v2/Users/:resourceId',
        async ({ request, server }) => await library(request, server),
        { parse: 'none' },
      )
      .delete(
        '/auth/scim/v2/Groups/:resourceId',
        async ({ request, server }) => await library(request, server),
        { parse: 'none' },
      )
      .post('/auth/logout', async ({ request, set }) =>
        respond(set, await signOut({ ...dependencies, bus: sockets.bus }, request)),
      )
      .post('/auth/logout-all', async ({ request, set }) =>
        respond(set, await signOutEverywhere({ ...dependencies, bus: sockets.bus }, request)),
      )
  );
};
