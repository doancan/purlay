/** Current live authority and trusted history are shared across a publication's queued recipients. */
import type {
  ChannelDeliveryScope,
  ChannelDeliveryVerdict,
} from '../../../platform/ports/channel-delivery';
import { currentRequest, withinRequest } from '../../../platform/logging';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { AppError } from '../../../platform/errors';
import type { ChatDb } from '../schema';
import type { ChannelContext } from './guard';
import { liveAudienceReader } from './live-audience';

export const liveChannelScope = (): ((
  database: ChatDb,
  context: ChannelContext,
) => ChannelDeliveryScope) => {
  const audience = liveAudienceReader();
  const expiryReads = new WeakMap<ChatDb, Map<string, Promise<boolean>>>();
  return (database, context) => {
    const guest = context.guest;
    const source = currentRequest();

    return {
      key: JSON.stringify([context.workspaceId, context.channelId, context.userId, guest ?? null]),
      expiresAt: guest?.expiresAt == null ? null : new Date(guest.expiresAt).getTime(),
      expiry: {
        workspaceId: context.workspaceId,
        recheck: async (signal): Promise<boolean> => {
          const key = JSON.stringify([
            context.workspaceId,
            context.userId,
            guest?.expiresAt ?? null,
            source?.sessionId ?? null,
          ]);
          const reads = expiryReads.get(database) ?? new Map<string, Promise<boolean>>();
          expiryReads.set(database, reads);
          let pending = reads.get(key);
          if (pending === undefined) {
            pending = withinRequest(
              {
                requestId: `live:chat:expiry:${context.workspaceId}`,
                startedAt: performance.now(),
                module: 'chat',
                signal,
                ...(source?.sessionId === undefined ? {} : { sessionId: source.sessionId }),
                ...(source?.companySession === undefined
                  ? {}
                  : { companySession: source.companySession }),
                ...(source?.workspaceAccess === undefined
                  ? {}
                  : { workspaceAccess: source.workspaceAccess }),
              },
              async () => {
                try {
                  await requireWorkspaceMembership(database, context.userId, context.workspaceId);
                  return true;
                } catch (error) {
                  if (
                    error instanceof AppError &&
                    (error.body.code === 'WORKSPACE_NOT_FOUND' ||
                      error.body.code === 'ROUTE_NOT_FOUND')
                  )
                    return false;
                  throw error;
                }
              },
            );
            reads.set(key, pending);
          }
          try {
            return await pending;
          } finally {
            if (reads.get(key) === pending) reads.delete(key);
          }
        },
      },
      accepts: async (frame, signal): Promise<ChannelDeliveryVerdict> => {
        let messageId: string | undefined;
        switch (frame.event) {
          case 'MESSAGE_CREATED':
            if (frame.data.channelId !== context.channelId) return false;
            messageId = frame.data.id;
            break;
          case 'MESSAGE_REVISED':
          case 'THREAD_UPDATED':
          case 'REACTIONS_UPDATED':
          case 'MESSAGE_VERSIONS_UPDATED':
          case 'MESSAGE_HIDDEN': {
            if (frame.data.channelId !== context.channelId) return false;
            messageId = frame.data.messageId;
            break;
          }
          case 'CHANNEL_STATE':
          case 'CHANNEL_UPDATED':
          case 'PINS_UPDATED':
          case 'BOOKMARKS_UPDATED':
          case 'INCIDENT_UPDATED':
          case 'TYPING':
            if (frame.data.channelId !== context.channelId) return false;
            break;
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
        const current = await audience(database, context, frame, messageId, signal);
        if (current === undefined) return 'revoked';
        if (guest === undefined) return current.accessKind === 'member' ? true : 'resync';
        const floor = new Date(guest.historySince).getTime();
        const currentFloor =
          current.historySince === null ? null : new Date(current.historySince).getTime();
        const currentEnd =
          current.expiresAt === null ? null : new Date(current.expiresAt).toISOString();
        if (
          current.accessKind !== 'guest' ||
          currentFloor !== floor ||
          currentEnd !== guest.expiresAt
        )
          return 'resync';
        return (
          messageId === undefined ||
          (current.messageCreatedAt !== null &&
            new Date(current.messageCreatedAt).getTime() >= floor)
        );
      },
    };
  };
};
