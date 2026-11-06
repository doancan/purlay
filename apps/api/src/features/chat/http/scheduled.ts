import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import {
  ScheduleMessageRequest,
  type ScheduledMessage,
  type ScheduledMessageList,
} from '@purlay/types';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { cancelScheduledMessage, scheduleMessage, scheduledMessages } from '../scheduled/scheduled';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import type { ChannelDependencies } from './channels';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

const putScheduled = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
  id: string,
  body: unknown,
): Promise<ScheduledMessage> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  const input = validated(ScheduleMessageRequest, body);
  return await atomicallyOn(dependencies.database)(async (transaction) => {
    await requireLiveSession(transaction, dependencies.clock, sessionId);
    return await scheduleMessage(transaction, dependencies.clock, userId, channelId, id, input);
  });
};

const deleteScheduled = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
  id: string,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  await atomicallyOn(dependencies.database)(async (transaction) => {
    await requireLiveSession(transaction, dependencies.clock, sessionId);
    await cancelScheduledMessage(transaction, userId, channelId, id);
  });
};

const listScheduled = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<ScheduledMessageList> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await scheduledMessages(dependencies.database, context);
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const scheduledRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/scheduled',
      async ({ request, params }) => await listScheduled(context, request, params.workspaceId),
    )
    .put(
      '/api/channels/:channelId/scheduled/:scheduledId',
      async ({ request, params, body }) =>
        await putScheduled(context, request, params.channelId, params.scheduledId, body),
    )
    .delete('/api/channels/:channelId/scheduled/:scheduledId', async ({ request, params, set }) => {
      await deleteScheduled(context, request, params.channelId, params.scheduledId);
      set.status = 204;
      return null;
    });
