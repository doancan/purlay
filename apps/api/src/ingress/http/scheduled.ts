import {
  ScheduleMessageRequest,
  type ScheduledMessage,
  type ScheduledMessageList,
} from '@purlay/types';
import { requireLiveSession } from '../../modules/auth/sessions';
import {
  cancelScheduledMessage,
  scheduleMessage,
  scheduledMessages,
} from '../../modules/scheduled/scheduled';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import type { ChannelDependencies } from './channels';
import { requireSession } from './session';
import { validated } from './validate';

export const putScheduled = async (
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

export const deleteScheduled = async (
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

export const listScheduled = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<ScheduledMessageList> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await scheduledMessages(dependencies.database, context);
};
