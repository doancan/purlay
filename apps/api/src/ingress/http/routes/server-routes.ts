/**
 * The server's administration (D-179 §4.8): the server's administrator alone; everybody else is absent. Its settings, its
 * sign-in channels, its accounts, its operations and its modules, and the two reads about the instance any signed-in person may ask.
 */
import { instanceInfo } from '../../../modules/administration/admission';
import {
  readAdministrationPush,
  writeAdministrationPush,
  readAdministrationPreferences,
  writeAdministrationPreferences,
  writeAdministrationAdmission,
  writeAdministrationBatchApproval,
  readOwnAdmission,
  readAdministrationBackups,
  readAdministrationMail,
  readAdministrationUsers,
  readAdministrationUser,
  readAdministrationWorkspaces,
  readAdministrationAudit,
  downloadAdministrationAudit,
  readAdministrationOverview,
  readAdministrationOperations,
  writeAdministrationRole,
  readAdministrationOutbox,
  readAdministrationOutboxFact,
  writeAdministrationOutbox,
  writeAdministrationModule,
  writeAdministrationModuleSuspension,
  readAdministrationModules,
  writeAdministrationQuota,
  writeAdministrationSessions,
  type AdministrationDependencies,
  type ModuleGrantDependencies,
  type ModuleSuspensionDependencies,
} from '../server-administration';
import { lift, readServerAccounts, suspend } from '../accounts';
import type { SetupDependencies } from '../setup';
import {
  changeSignInPolicy,
  changeWorkspaceCreators,
  connectGitHubApp,
  connectGoogleClient,
  connectOidcProvider,
  connectMailRelay,
  connectIssuesApp,
  disconnectChannel,
  disconnectIssuesApp,
  readServerSettings,
  trySavedServerRelay,
} from '../server';
import { Elysia, type AnyElysia } from 'elysia';
import type { RouteContext } from '../route-context';

export const serverRoutes = (
  context: RouteContext,
  setup: SetupDependencies,
  administration: AdministrationDependencies &
    ModuleGrantDependencies &
    ModuleSuspensionDependencies,
): AnyElysia => {
  const { dependencies, sockets } = context;

  return (
    new Elysia()
      .get(
        '/api/server/push',
        async ({ request }) => await readAdministrationPush(administration, request),
      )
      .put(
        '/api/server/push',
        async ({ request, body }) => await writeAdministrationPush(administration, request, body),
      )
      .get('/api/instance', async () => await instanceInfo(dependencies.database))
      .get('/api/admission', async ({ request }) => await readOwnAdmission(administration, request))
      .get(
        '/api/server/preferences',
        async ({ request }) => await readAdministrationPreferences(administration, request),
      )
      .post('/api/server/preferences', async ({ request, body, set }) => {
        await writeAdministrationPreferences(administration, request, body);
        set.status = 204;
        return '';
      })
      .post('/api/server/users/:userId/admission', async ({ request, params, body, set }) => {
        await writeAdministrationAdmission(administration, request, params.userId, body);
        set.status = 204;
        return '';
      })
      .get(
        '/api/server/backups',
        async ({ request }) => await readAdministrationBackups(administration, request),
      )
      // Administration → Server (D-179 §4.8): the server's administrator alone; everybody else is absent.
      .get(
        '/api/server/mail-test',
        async ({ request }) => await readAdministrationMail(administration, request),
      )
      .post(
        '/api/server/mail-test',
        async ({ request, body }) => await trySavedServerRelay(setup, request, body),
      )
      .get(
        '/api/server/overview',
        async ({ request }) => await readAdministrationOverview(administration, request),
      )
      .get(
        '/api/server/operations',
        async ({ request }) => await readAdministrationOperations(administration, request),
      )
      .get(
        '/api/server/users',
        async ({ request }) => await readAdministrationUsers(administration, request),
      )
      .get(
        '/api/server/users/:userId',
        async ({ request, params }) =>
          await readAdministrationUser(administration, request, params.userId),
      )
      .get(
        '/api/server/workspaces',
        async ({ request }) => await readAdministrationWorkspaces(administration, request),
      )
      .get(
        '/api/server/outbox',
        async ({ request }) => await readAdministrationOutbox(administration, request),
      )
      .get(
        '/api/server/outbox/:id',
        async ({ request, params }) =>
          await readAdministrationOutboxFact(administration, request, params.id),
      )
      .get(
        '/api/server/audit',
        async ({ request }) => await readAdministrationAudit(administration, request),
      )
      .get(
        '/api/server/audit/export',
        async ({ request }) => await downloadAdministrationAudit(administration, request),
      )
      .post(
        '/api/server/outbox/requeue',
        async ({ request, body }) =>
          await writeAdministrationOutbox(administration, request, 'requeue', body),
      )
      .post(
        '/api/server/outbox/discard',
        async ({ request, body }) =>
          await writeAdministrationOutbox(administration, request, 'discard', body),
      )
      .post(
        '/api/server/users/approve',
        async ({ request, body }) =>
          await writeAdministrationBatchApproval(administration, request, body),
      )
      .post('/api/server/users/:userId/admin', async ({ request, params, body, set }) => {
        await writeAdministrationRole(administration, request, params.userId, body);
        set.status = 204;
        return '';
      })
      .post('/api/server/users/:userId/revoke-sessions', async ({ request, params, body, set }) => {
        await writeAdministrationSessions(administration, request, params.userId, body);
        set.status = 204;
        return '';
      })
      .post('/api/server/workspaces/:workspaceId/quota', async ({ request, params, body, set }) => {
        await writeAdministrationQuota(administration, request, params.workspaceId, body);
        set.status = 204;
        return '';
      })
      .get(
        '/api/server/modules',
        async ({ request }) => await readAdministrationModules(administration, request),
      )
      .post(
        '/api/server/modules/:moduleId/suspension',
        async ({ request, params, body }) =>
          await writeAdministrationModuleSuspension(administration, request, params.moduleId, body),
      )
      .post(
        '/api/server/workspaces/:workspaceId/modules',
        async ({ request, params, body, set }) => {
          await writeAdministrationModule(administration, request, params.workspaceId, body);
          set.status = 204;
          return '';
        },
      )
      .get('/api/server/settings', async ({ request }) => await readServerSettings(setup, request))
      .post(
        '/api/server/github',
        async ({ request, body }) => await connectGitHubApp(setup, request, body),
      )
      .post(
        '/api/server/oidc',
        async ({ request, body }) => await connectOidcProvider(setup, request, body),
      )
      .post(
        '/api/server/google',
        async ({ request, body }) => await connectGoogleClient(setup, request, body),
      )
      .post(
        '/api/server/smtp',
        async ({ request, body }) => await connectMailRelay(setup, request, body),
      )
      .delete('/api/server/github', async ({ request, set }) => {
        await disconnectChannel(setup, request, 'github');
        set.status = 204;
        return '';
      })
      .post(
        '/api/server/github-app',
        async ({ request, body }) => await connectIssuesApp(setup, request, body),
      )
      .delete('/api/server/github-app', async ({ request, set }) => {
        await disconnectIssuesApp(setup, request);
        set.status = 204;
        return '';
      })
      .delete('/api/server/oidc', async ({ request, set }) => {
        await disconnectChannel(setup, request, 'oidc');
        set.status = 204;
        return '';
      })
      .delete('/api/server/google', async ({ request, set }) => {
        await disconnectChannel(setup, request, 'google');
        set.status = 204;
        return '';
      })
      .delete('/api/server/smtp', async ({ request, set }) => {
        await disconnectChannel(setup, request, 'smtp');
        set.status = 204;
        return '';
      })
      .post('/api/server/policy', async ({ request, body, set }) => {
        await changeSignInPolicy(setup, request, body);
        set.status = 204;
        return '';
      })
      .post('/api/server/creators', async ({ request, body, set }) => {
        await changeWorkspaceCreators(setup, request, body);
        set.status = 204;
        return '';
      })
      .get(
        '/api/server/accounts',
        async ({ request }) =>
          await readServerAccounts({ ...dependencies, bus: sockets.bus }, request),
      )
      .put('/api/server/accounts/:userId/suspension', async ({ request, params, set }) => {
        await suspend({ ...dependencies, bus: sockets.bus }, request, params.userId);
        set.status = 204;
        return '';
      })
      .delete('/api/server/accounts/:userId/suspension', async ({ request, params, set }) => {
        await lift({ ...dependencies, bus: sockets.bus }, request, params.userId);
        set.status = 204;
        return '';
      })
  );
};
