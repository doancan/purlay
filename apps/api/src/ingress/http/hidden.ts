import type { Message } from '@purlay/types';
import { requireLiveSession } from '../../modules/auth/sessions';
import { hideMessage } from '../../modules/messages/hide';
import {
  inboxPublications,
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelState,
  publishRemindersUpdated,
  publishSavedUpdated,
  userTopic,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import type { ChannelWriteDependencies } from './channels';
import { requireSession } from './session';

export const hideMyMessage = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  messageId: string,
): Promise<Message> => {
  const { userId, sessionId } = await requireSession(dependencies.auth, request);
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const result = await atomicallyOn(database)(async (tx) => {
    await requireLiveSession(tx, clock, sessionId);
    return await hideMessage(tx, clock, userId, messageId);
  });
  await publishAfterCommit(log, [
    [
      publication('MESSAGE_HIDDEN', async () => {
        await bus.publish(userTopic(userId), {
          event: 'MESSAGE_HIDDEN',
          data: {
            workspaceId: result.workspaceId,
            channelId: result.message.channelId,
            messageId,
            hiddenAt: result.at,
          },
          ts: clock.now().getTime(),
        });
      }),
    ],
    result.states.map((state) =>
      publication('CHANNEL_STATE', async () => {
        await publishChannelState(bus, clock, userId, state.channelId, state.state, state.version);
      }),
    ),
    [
      publication('REMINDERS_UPDATED', async () => {
        await publishRemindersUpdated(bus, clock, userId, result.workspaceId);
      }),
      publication('SAVED_UPDATED', async () => {
        await publishSavedUpdated(bus, clock, userId, result.workspaceId);
      }),
    ],
    inboxPublications(bus, clock, result.workspaceId, [userId]),
  ]);
  return result.message;
};
