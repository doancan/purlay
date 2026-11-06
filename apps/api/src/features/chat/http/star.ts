/**
 * `PUT` and `DELETE /api/channels/:channelId/star` (#489, D-132): the caller's own star on a channel
 * they are in. A change tells the caller's other tabs to read their channels again, after it is
 * written; nobody else hears anything.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { requireChannelById } from '../channels/guard';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelsUpdated,
} from '../../../platform/events';
import { setStarred } from '../channels/star';
import type { ChannelWriteDependencies } from './channels';
import { requireSession } from '../../../ingress/http/session';

export const starChannel = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  starred: boolean,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  if (!(await setStarred(database, clock, context, starred))) return;
  await publishAfterCommit(log, [
    [
      publication('CHANNELS_UPDATED', () =>
        publishChannelsUpdated(bus, clock, userId, context.workspaceId),
      ),
    ],
  ]);
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const starRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .put('/api/channels/:channelId/star', async ({ request, params, set }) => {
      await starChannel(context, request, params.channelId, true);
      set.status = 204;
      return null;
    })
    .delete('/api/channels/:channelId/star', async ({ request, params, set }) => {
      await starChannel(context, request, params.channelId, false);
      set.status = 204;
      return null;
    });
