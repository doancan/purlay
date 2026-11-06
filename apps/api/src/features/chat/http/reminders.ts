import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import {
  SetMessageReminderRequest,
  type MessageReminder,
  type MessageReminderList,
} from '@purlay/types';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { cancelReminder, reminderList, setReminder } from '../reminders/reminders';
import { requireMessageById } from '../channels/guard';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishRemindersUpdated,
} from '../../../platform/events';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

const told = async (
  { bus, clock, log = NO_LOG }: ChannelWriteDependencies,
  user: string,
  workspace: string,
): Promise<void> => {
  await publishAfterCommit(log, [
    [
      publication('REMINDERS_UPDATED', async () => {
        await publishRemindersUpdated(bus, clock, user, workspace);
      }),
    ],
  ]);
};
const putReminder = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
  body: unknown,
): Promise<MessageReminder> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  const input = validated(SetMessageReminderRequest, body);
  const result = await atomicallyOn(dependencies.database)(async (tx) => {
    await requireLiveSession(tx, dependencies.clock, sessionId);
    const { context } = await requireMessageById(tx, userId, messageId);
    const reminder = await setReminder(tx, dependencies.clock, userId, messageId, input.remindAt);
    return { reminder, workspace: context.workspaceId };
  });
  await told(dependencies, userId, result.workspace);
  return result.reminder;
};
const deleteReminder = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  const workspace = await atomicallyOn(dependencies.database)(async (tx) => {
    await requireLiveSession(tx, dependencies.clock, sessionId);
    return await cancelReminder(tx, userId, messageId);
  });
  await told(dependencies, userId, workspace);
};
const listReminders = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<MessageReminderList> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await reminderList(
    dependencies.database,
    await requireWorkspaceMembership(dependencies.database, userId, workspaceId),
  );
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const reminderRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .put(
      '/api/messages/:messageId/reminder',
      async ({ request, params, body }) =>
        await putReminder(context, request, params.messageId, body),
    )
    .delete('/api/messages/:messageId/reminder', async ({ request, params, set }) => {
      await deleteReminder(context, request, params.messageId);
      set.status = 204;
      return null;
    })
    .get(
      '/api/workspaces/:workspaceId/reminders',
      async ({ request, params }) => await listReminders(context, request, params.workspaceId),
    );
