/** Trusted message timestamps shared across recipients of one publication, never one permission query per socket. */
import type { ServerFrame } from '@purlay/types';
import type { ChannelDeliveryScope } from '../../../platform/ports/channel-delivery';
import { withinRequest } from '../../../platform/logging';
import type { ChatDb } from '../schema';
import type { ChannelContext } from './guard';

export const liveGuestHistory = (): ((
  database: ChatDb,
  context: ChannelContext,
) => ChannelDeliveryScope | undefined) => {
  const timestamps = new WeakMap<ServerFrame, Promise<Date | null>>();
  return (database, context) => {
    const guest = context.guest;
    if (guest === undefined) return undefined;
    const floor = new Date(guest.historySince).getTime();
    return {
      key: JSON.stringify([context.workspaceId, context.channelId, context.userId, guest]),
      expiresAt: guest.expiresAt === null ? null : new Date(guest.expiresAt).getTime(),
      accepts: async (frame, signal): Promise<boolean> => {
        if (frame.event === 'MESSAGE_CREATED')
          return (
            frame.data.channelId === context.channelId &&
            new Date(frame.data.createdAt).getTime() >= floor
          );
        switch (frame.event) {
          case 'MESSAGE_REVISED':
          case 'THREAD_UPDATED':
          case 'REACTIONS_UPDATED':
          case 'MESSAGE_VERSIONS_UPDATED':
          case 'MESSAGE_HIDDEN': {
            if (frame.data.channelId !== context.channelId) return false;
            let timestamp = timestamps.get(frame);
            if (timestamp === undefined) {
              const messageId = frame.data.messageId;
              timestamp = withinRequest(
                {
                  requestId: `live:chat:${messageId}`,
                  startedAt: performance.now(),
                  module: 'chat',
                  signal,
                },
                async () =>
                  (
                    await database
                      .selectFrom('messages')
                      .select('created_at')
                      .where('id', '=', messageId)
                      .where('channel_id', '=', context.channelId)
                      .executeTakeFirst()
                  )?.created_at ?? null,
              );
              timestamps.set(frame, timestamp);
            }
            const createdAt = await timestamp;
            return createdAt !== null && new Date(createdAt).getTime() >= floor;
          }
          case 'CHANNEL_STATE':
          case 'CHANNEL_UPDATED':
          case 'PINS_UPDATED':
          case 'BOOKMARKS_UPDATED':
          case 'INCIDENT_UPDATED':
          case 'TYPING':
            return true;
          case 'ACCESS_REVOKED':
          case 'ACK':
          case 'CHANNEL_ADDED':
          case 'CHANNELS_UPDATED':
          case 'DEEP_WORK_UPDATED':
          case 'ERROR':
          case 'INBOX_UPDATED':
          case 'NOTIFICATIONS_UPDATED':
          case 'PONG':
          case 'PRESENCE':
          case 'REMINDERS_UPDATED':
          case 'SAVED_UPDATED':
          case 'SESSION_ENDED':
          case 'WORKSPACE_UPDATED':
            return false;
        }
      },
    };
  };
};
