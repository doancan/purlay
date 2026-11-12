/** Project account-wide publications onto the native company session's single workspace. */
import type { ServerFrame } from '@purlay/types';
import { withinRequest } from '../../../platform/logging';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { AppError } from '../../../platform/errors';
import type { CompanyFrameProjector } from '../../../platform/ports/channel-delivery';
import type { ChatDb } from '../schema';
import { requireChannelById } from './guard';

export const companyFrameProjector =
  (database: ChatDb): CompanyFrameProjector =>
  async (identity, frame, signal): Promise<ServerFrame | undefined> =>
    await withinRequest(
      {
        requestId: `live:company:${identity.sessionId}`,
        startedAt: performance.now(),
        sessionId: identity.sessionId,
        companySession: { userId: identity.userId, workspaceId: identity.workspaceId },
        module: 'chat',
        signal,
      },
      async () => {
        const context = await requireWorkspaceMembership(
          database,
          identity.userId,
          identity.workspaceId,
        );
        switch (frame.event) {
          case 'SESSION_ENDED':
          case 'ACK':
          case 'ERROR':
          case 'PONG':
            return frame;
          case 'WORKSPACE_UPDATED':
          case 'DEEP_WORK_UPDATED':
          case 'INBOX_UPDATED':
          case 'SAVED_UPDATED':
          case 'REMINDERS_UPDATED':
          case 'NOTIFICATIONS_UPDATED':
          case 'CHANNELS_UPDATED':
            return frame.data.workspaceId === context.workspaceId ? frame : undefined;
          case 'PRESENCE': {
            const members = await database
              .selectFrom('workspace_members')
              .select('user_id')
              .where('workspace_id', '=', context.workspaceId)
              .where(
                'user_id',
                'in',
                frame.data.changes.map((change) => change.userId),
              )
              .execute();
            const known = new Set(members.map((row) => row.user_id));
            const changes = frame.data.changes.filter((change) => known.has(change.userId));
            return changes.length === 0 ? undefined : { ...frame, data: { changes } };
          }
          case 'ACCESS_REVOKED': {
            // A channel just left may no longer mint a channel capability; this notice grants no content.
            const rows = await database
              .selectFrom('channels')
              .select('id')
              .where('workspace_id', '=', context.workspaceId)
              .where('id', 'in', frame.data.channelIds)
              .execute();
            const own = new Set(rows.map((row) => row.id));
            const channelIds = frame.data.channelIds.filter((id) => own.has(id));
            return channelIds.length === 0
              ? undefined
              : { ...frame, data: { ...frame.data, channelIds } };
          }
          case 'CHANNEL_ADDED':
            if (frame.data.workspaceId !== context.workspaceId) return undefined;
            return await inChannel(frame.data.id);
          case 'MESSAGE_CREATED':
          case 'MESSAGE_REVISED':
          case 'MESSAGE_HIDDEN':
          case 'THREAD_UPDATED':
          case 'REACTIONS_UPDATED':
          case 'CHANNEL_STATE':
          case 'CHANNEL_UPDATED':
          case 'PINS_UPDATED':
          case 'BOOKMARKS_UPDATED':
          case 'INCIDENT_UPDATED':
          case 'MESSAGE_VERSIONS_UPDATED':
          case 'TYPING':
            return await inChannel(frame.data.channelId);
        }
        async function inChannel(channelId: string): Promise<ServerFrame | undefined> {
          try {
            const channel = await requireChannelById(database, identity.userId, channelId);
            return channel.workspaceId === context.workspaceId ? frame : undefined;
          } catch (error) {
            if (
              error instanceof AppError &&
              (error.body.code === 'CHANNEL_NOT_FOUND' || error.body.code === 'WORKSPACE_NOT_FOUND')
            )
              return undefined;
            throw error;
          }
        }
      },
    );
