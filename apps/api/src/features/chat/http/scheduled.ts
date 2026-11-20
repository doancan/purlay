import { Elysia, type AnyElysia } from 'elysia';
import type { ChatRouteDependencies } from './dependencies';
import {
  ScheduleMessageRequest,
  type Message,
  type ScheduledMessage,
  type ScheduledMessageList,
} from '@purlay/types';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { cancelScheduledMessage, scheduleMessage, scheduledMessages } from '../scheduled/scheduled';
import { sendScheduledNow } from '../scheduled/delivery';
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

/** `POST …/scheduled/:scheduledId/send` — Send now: delivered by the scheduler's path, at once (D-324). */
const sendNow = async (
  dependencies: ChatRouteDependencies,
  request: Request,
  channelId: string,
  id: string,
): Promise<Message> => {
  const caller = await requireSession(dependencies.auth, request);
  return await sendScheduledNow(dependencies, caller, channelId, id);
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
export const scheduledRoutes = (context: ChatRouteDependencies): AnyElysia =>
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
    .post(
      '/api/channels/:channelId/scheduled/:scheduledId/send',
      async ({ request, params }) =>
        await sendNow(context, request, params.channelId, params.scheduledId),
    )
    .delete('/api/channels/:channelId/scheduled/:scheduledId', async ({ request, params, set }) => {
      await deleteScheduled(context, request, params.channelId, params.scheduledId);
      set.status = 204;
      return null;
    });
