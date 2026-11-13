/**
 * The signed-in person's own: their account, sessions, exports, profile, quiet hours, away, locale and the devices that
 * are told of what needs them, and the release this server runs.
 */
import type { pushConfiguration } from '../../../modules/push/settings';
import { askForMyExport, downloadMyExport, readMyExports } from '../exports';
import { readLatestRelease } from '../releases';
import { readMySignIn, eraseMyAccount, type EraseDependencies } from '../auth';
import { endMySession, readMySessions } from '../devices';
import { readMe } from '../workspaces';
import { readPushKey, setMyLocale, subscribeDevice, unsubscribeDevice } from '../push';
import { updateMyProfile } from '../profile';
import { readMyQuietHours, setMyQuietHours } from '../quiet-hours';
import { setMyAway } from '../away';
import { Elysia, type AnyElysia } from 'elysia';
import { creatingOf, sendingOf, type RouteContext } from '../route-context';
import { respond } from '../route-answers';

export const meRoutes = (
  context: RouteContext,
  own: {
    readonly browserPush: ReturnType<typeof pushConfiguration>;
    readonly releases: Parameters<typeof readLatestRelease>[0]['releases'];
    readonly erasureServices: EraseDependencies['erasureServices'];
  },
): AnyElysia => {
  const { dependencies, sockets } = context;
  const { releases, erasureServices } = own;
  const creating = creatingOf(context);
  const sending = sendingOf(context);
  const pushDependencies = { ...dependencies, pushConfiguration: own.browserPush };

  return (
    new Elysia()
      .post('/api/me/erase', async ({ request, body, set }) =>
        respond(
          set,
          await eraseMyAccount(
            {
              ...dependencies,
              bus: sockets.bus,
              erasureServices,
            },
            request,
            body,
          ),
        ),
      )
      .post('/api/me/exports', async ({ request, set }) => {
        const asked = await askForMyExport(dependencies, request);
        set.status = 202;
        return asked;
      })
      .get('/api/me/exports', async ({ request }) => await readMyExports(dependencies, request))
      .get('/api/me/exports/:exportId/download', async ({ request, params }) => {
        const { body, headers } = await downloadMyExport(
          { ...dependencies, personalCatalogue: context.modules.personalExportCatalogue },
          request,
          params.exportId,
        );
        // Our own Response, as an owner's export's download is: a cancel must reach the archive's.
        return new Response(body, { headers });
      })
      .get('/api/me', async ({ request }) => await readMe(creating, request))
      .get(
        '/api/releases/latest',
        async ({ request }) =>
          await readLatestRelease({ auth: dependencies.auth, releases }, request),
      )
      .get('/api/me/sign-in', async ({ request }) => await readMySignIn(dependencies, request))
      .get(
        '/api/me/sessions',
        async ({ request }) => await readMySessions({ ...dependencies, bus: sockets.bus }, request),
      )
      .delete('/api/me/sessions/:sessionId', async ({ request, params, set }) => {
        await endMySession({ ...dependencies, bus: sockets.bus }, request, params.sessionId);
        set.status = 204;
        return null;
      })
      .patch(
        '/api/me/profile',
        async ({ request, body }) => await updateMyProfile(sending, request, body),
      )
      .get(
        '/api/me/quiet-hours',
        async ({ request }) => await readMyQuietHours(dependencies, request),
      )
      .put(
        '/api/me/quiet-hours',
        async ({ request, body }) => await setMyQuietHours(dependencies, request, body),
      )
      // Away by choice (D-257): stored, then told again through the presence this node keeps.
      .put(
        '/api/me/away',
        async ({ request, body }) => await setMyAway(dependencies, sockets.online, request, body),
      )
      .put('/api/me/locale', async ({ request, body, set }) => {
        await setMyLocale(pushDependencies, request, body);
        set.status = 204;
        return null;
      })
      .get('/api/push/key', async ({ request }) => await readPushKey(pushDependencies, request))
      .post('/api/push/subscriptions', async ({ request, body, set }) => {
        await subscribeDevice(pushDependencies, request, body);
        set.status = 204;
        return null;
      })
      .post('/api/push/subscriptions/remove', async ({ request, body, set }) => {
        await unsubscribeDevice(pushDependencies, request, body);
        set.status = 204;
        return null;
      })
  );
};
