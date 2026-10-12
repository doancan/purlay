/**
 * The inbox endpoints (`API.md` §6, D-106).
 *
 * The workspace is named in the query or the body rather than the path, and is asked of the guard
 * before anything else is read: a stranger, a workspace that never existed and an id that is not
 * one are the same `404` (D-34), whatever else the request says.
 */
import { NotificationQuery, ReadNotificationsRequest, type NotificationPage } from '@purlay/types';
import { visibleChannelIds } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelState,
} from '../../platform/events';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { inboxOf, readNotifications } from '../../modules/notifications/notifications';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';
import { validated } from './validate';

/** `GET /api/notifications?workspaceId=` — the caller's inbox in one workspace, newest first. */
export const readInbox = async (
  dependencies: ChannelDependencies,
  request: Request,
): Promise<NotificationPage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const url = new URL(request.url);
  // Every parameter goes to the schema, so one it does not know is refused by name rather than
  // ignored. Query strings are text: the two that are not are converted, and anything but the words
  // they expect is left as it came, for the schema to refuse.
  const query: Record<string, unknown> = Object.fromEntries(url.searchParams);
  const unreadOnly = url.searchParams.get('unreadOnly');
  if (unreadOnly === 'true' || unreadOnly === 'false') query['unreadOnly'] = unreadOnly === 'true';
  const limit = url.searchParams.get('limit');
  if (limit !== null) query['limit'] = Number(limit);
  const workspaceId = url.searchParams.get('workspaceId');
  const context =
    workspaceId === null
      ? undefined
      : await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(NotificationQuery, query);
  if (context === undefined) throw new Error('validated a query without a workspaceId');
  return await inboxOf(database, context, await visibleChannelIds(database, context), input);
};

/**
 * `PUT /api/notifications/read` — marks the caller's notifications read; each channel whose badge
 * moved is told to the caller's devices after the commit, on their own topic (D-99 §4).
 */
export const markNotificationsRead = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const input = validated(ReadNotificationsRequest, body);
  const told = await atomicallyOn(database)(
    async (transaction) => await readNotifications(transaction, clock, userId, input),
  );
  await publishAfterCommit(log, [
    told.map((channel) =>
      publication('CHANNEL_STATE', () =>
        publishChannelState(bus, clock, userId, channel.channelId, channel.state, channel.version),
      ),
    ),
  ]);
};
