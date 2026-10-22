/**
 * `PUT` and `DELETE /api/channels/:channelId/star` (#489, D-132): the caller's own star on a channel
 * they are in. A change tells the caller's other tabs to read their channels again, after it is
 * written; nobody else hears anything.
 */
import { requireChannelById } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelsUpdated,
} from '../../platform/events';
import { setStarred } from '../../modules/channels/star';
import type { ChannelWriteDependencies } from './channels';
import { requireSession } from './session';

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
