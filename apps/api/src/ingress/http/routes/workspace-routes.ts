/**
 * A workspace and what belongs to it in the core: the person's workspaces, its members, invitations, exports, retention,
 * storage, search, audit trail, deletion, deep work and inbox. A module's own routes are the module's (`module-routes.ts`).
 */
import { askForExport, downloadExport, readExports } from '../exports';
import {
  createMyWorkspace,
  listMyWorkspaces,
  setMyDeepWork,
  listWorkspaceMembers,
  readAuditTrail,
  exportAuditTrail,
  removeWorkspaceMember,
  leaveWorkspaceMembership,
  requestWorkspaceDeletion,
  cancelWorkspaceDeletion,
  updateMemberRole,
  readWorkspace,
  updateWorkspace,
  readRetentionSetting,
  readStorageUsage,
  updateRetentionSetting,
} from '../workspaces';
import { readFind } from '../find';
import {
  dropInvitation,
  readInvitationRecipients,
  readInvitationDeliveries,
  resendRecipient,
  dropRecipient,
  joinByInvitation,
  lookAtInvitation,
  makeInvitation,
  openPassport,
  readInvitations,
  type InvitationMailDependencies,
} from '../invitations';
import { listInbox, readInbox } from '../inbox';
import { Elysia, type AnyElysia } from 'elysia';
import { creatingOf, sendingOf, type RouteContext } from '../route-context';

export const workspaceRoutes = (
  context: RouteContext,
  invitationLater: InvitationMailDependencies['later'],
): AnyElysia => {
  const { dependencies, modules, deadlineOf, sockets } = context;
  const creating = creatingOf(context);
  const sending = sendingOf(context);
  const inboxDependencies = {
    ...sending,
    running: modules.modules.map((module) => module.manifest.id),
  };
  // Invitation letters are posted after the answer too, by the relay the sign-in library mails through.
  const invitationMail = (): InvitationMailDependencies => ({
    ...dependencies,
    appUrl: dependencies.config.APP_URL,
    outbox: dependencies.auth.signInLinks?.outbox,
    later: invitationLater,
  });

  return new Elysia()
    .get(
      '/api/workspaces',
      async ({ request }) =>
        await listMyWorkspaces(
          { ...dependencies, effectiveModules: modules.effectiveModules },
          request,
        ),
    )
    .post('/api/workspaces', async ({ request, body, set }) => {
      set.status = 201;
      return await createMyWorkspace(creating, request, body);
    })
    .get(
      '/api/workspaces/:workspaceId',
      async ({ request, params }) => await readWorkspace(dependencies, request, params.workspaceId),
    )
    .patch(
      '/api/workspaces/:workspaceId',
      async ({ request, params, body }) =>
        await updateWorkspace(sending, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/members',
      async ({ request, params }) =>
        await listWorkspaceMembers(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/invitation-recipients',
      async ({ request, params }) =>
        await readInvitationRecipients(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/invitation-recipients/:recipientId/attempts',
      async ({ request, params }) =>
        await readInvitationDeliveries(
          dependencies,
          request,
          params.workspaceId,
          params.recipientId,
        ),
    )
    .post(
      '/api/workspaces/:workspaceId/invitation-recipients/:recipientId/resend',
      async ({ request, params, set }) => {
        await resendRecipient(invitationMail(), request, params.workspaceId, params.recipientId);
        set.status = 204;
      },
    )
    .delete(
      '/api/workspaces/:workspaceId/invitation-recipients/:recipientId',
      async ({ request, params, set }) => {
        await dropRecipient(dependencies, request, params.workspaceId, params.recipientId);
        set.status = 204;
      },
    )
    .post('/api/workspaces/:workspaceId/invitations', async ({ request, params, body, set }) => {
      set.status = 201;
      return await makeInvitation(invitationMail(), request, params.workspaceId, body);
    })
    .get(
      '/api/workspaces/:workspaceId/invitations',
      async ({ request, params }) =>
        await readInvitations(dependencies, request, params.workspaceId),
    )
    .delete(
      '/api/workspaces/:workspaceId/invitations/:invitationId',
      async ({ request, params, set }) => {
        await dropInvitation(dependencies, request, params.workspaceId, params.invitationId);
        set.status = 204;
        return null;
      },
    )
    .post(
      '/api/invitations/preview',
      async ({ request, body }) => await lookAtInvitation(dependencies, request, body),
    )
    .post('/api/invitations/passport', async ({ body, set }) => {
      const { setCookie } = await openPassport(dependencies, body);
      if (setCookie.length > 0) set.headers['set-cookie'] = [...setCookie];
      set.status = 204;
      return '';
    })
    .post(
      '/api/invitations/accept',
      async ({ request, body }) =>
        await joinByInvitation(
          { ...dependencies, bus: sockets.bus, effectiveModules: modules.effectiveModules },
          request,
          body,
        ),
    )
    .post('/api/workspaces/:workspaceId/exports', async ({ request, params, set }) => {
      const asked = await askForExport(dependencies, request, params.workspaceId);
      set.status = 202;
      return asked;
    })
    .get(
      '/api/workspaces/:workspaceId/exports',
      async ({ request, params }) => await readExports(dependencies, request, params.workspaceId),
    )
    .get('/api/workspaces/:workspaceId/exports/:exportId/download', async ({ request, params }) => {
      const { body, headers } = await downloadExport(
        dependencies,
        request,
        params.workspaceId,
        params.exportId,
      );
      // A Response of our own: a bare stream Elysia would wrap, and a browser that goes away would
      // cancel the wrapper, never reaching the archive's `cancel` that spends it.
      return new Response(body, { headers });
    })
    .get(
      '/api/workspaces/:workspaceId/retention',
      async ({ request, params }) =>
        await readRetentionSetting(dependencies, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/retention',
      async ({ request, params, body }) =>
        await updateRetentionSetting(dependencies, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/storage',
      async ({ request, params }) =>
        await readStorageUsage(dependencies, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/find',
      async ({ request, params }) =>
        await readFind(
          {
            ...dependencies,
            sources: modules.findSources,
            off: modules.findSourcesOff,
            deadlineOf,
            ...(dependencies.findDeadlineMs === undefined
              ? {}
              : { sourceDeadlineMs: dependencies.findDeadlineMs }),
          },
          request,
          params.workspaceId,
        ),
    )
    .get(
      '/api/workspaces/:workspaceId/audit',
      async ({ request, params }) =>
        await readAuditTrail(dependencies, request, params.workspaceId),
    )
    .get('/api/workspaces/:workspaceId/audit/export', async ({ request, params }) => {
      const { body, headers } = await exportAuditTrail(dependencies, request, params.workspaceId);
      // A Response of our own, as an export's download is: a bare stream Elysia would wrap, and a
      // browser that goes away would cancel the wrapper, not the pages being read.
      return new Response(body, { headers });
    })
    .patch(
      '/api/workspaces/:workspaceId/members/:userId',
      async ({ request, params, body }) =>
        await updateMemberRole(dependencies, request, params.workspaceId, params.userId, body),
    )
    .delete('/api/workspaces/:workspaceId/members/:userId', async ({ request, params, set }) => {
      await removeWorkspaceMember(sending, request, params.workspaceId, params.userId);
      set.status = 204;
      return null;
    })
    .delete('/api/workspaces/:workspaceId/membership', async ({ request, params, set }) => {
      await leaveWorkspaceMembership(sending, request, params.workspaceId);
      set.status = 204;
      return null;
    })
    .post(
      '/api/workspaces/:workspaceId/deletion',
      async ({ request, params, body }) =>
        await requestWorkspaceDeletion(sending, request, params.workspaceId, body),
    )
    .delete('/api/workspaces/:workspaceId/deletion', async ({ request, params, set }) => {
      await cancelWorkspaceDeletion(sending, request, params.workspaceId);
      set.status = 204;
      return null;
    })
    .put(
      '/api/workspaces/:workspaceId/deep-work',
      async ({ request, params, body }) =>
        await setMyDeepWork(sending, request, params.workspaceId, body),
    )
    .get(
      '/api/workspaces/:workspaceId/inbox',
      async ({ request, params }) =>
        await listInbox(inboxDependencies, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/inbox/read', async ({ request, params, body, set }) => {
      await readInbox(inboxDependencies, request, params.workspaceId, body);
      set.status = 204;
      return null;
    });
};
