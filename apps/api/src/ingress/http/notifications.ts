/**
 * The inbox endpoints (`API.md` §6, D-106), and reading a thread, which reads its notifications
 * (`API.md` §5, D-147).
 *
 * The workspace is named in the query or the body rather than the path, and is asked of the guard
 * before anything else is read: a stranger, a workspace that never existed and an id that is not
 * one are the same `404` (D-34), whatever else the request says.
 */
import {
  NotificationQuery,
  ReadNotificationsRequest,
  ReadThreadRequest,
  type NotificationPage,
} from '@purlay/types';
import { visibleChannelIds } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelState,
} from '../../platform/events';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import {
  inboxOf,
  readNotifications,
  readThreadNotifications,
  type Told,
} from '../../modules/notifications/notifications';
import type { ChannelDependencies, ChannelWriteDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/** `GET /api/notifications?workspaceId=` — the caller's inbox in one workspace, newest first. */
export const readInbox = async (
  dependencies: ChannelDependencies,
  request: Request,
): Promise<NotificationPage> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const url = new URL(request.url);
  const query = queryOf(url, { numbers: ['limit'], booleans: ['unreadOnly'] });
  // The workspace is asked of the guard before the rest is read, so a stranger is told 404 whatever
  // else the query says (D-34); with none at all, the schema says what is missing.
  const context = await requireWorkspaceMembership(
    database,
    userId,
    url.searchParams.get('workspaceId') ?? validated(NotificationQuery, query).workspaceId,
  );
  const input = validated(NotificationQuery, query);
  return await inboxOf(database, context, await visibleChannelIds(database, context), input);
};

/**
 * `PUT /api/notifications/read` — marks the caller's notifications read; each channel with one newly
 * read is told to the caller's devices after the commit, on their own topic (D-99 §4, D-106).
 */
export const markNotificationsRead = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const input = validated(ReadNotificationsRequest, body);
  const told = await atomicallyOn(database)(
    async (transaction) => await readNotifications(transaction, clock, userId, input),
  );
  await tell(dependencies, userId, told);
};

/**
 * `PUT /api/messages/:messageId/thread/read` — the thread of this root has been read up to and
 * including a reply: the caller's notifications for its replies are read (D-147), and the channel's
 * new numbers go to the caller's devices after the commit, as the inbox's do.
 */
export const markThreadRead = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  rootId: string,
  body: unknown,
): Promise<void> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const input = validated(ReadThreadRequest, body);
  const told = await atomicallyOn(database)(
    async (transaction) => await readThreadNotifications(transaction, clock, userId, rootId, input),
  );
  await tell(dependencies, userId, told);
};

/** Each channel with a notification newly read, told to the caller's own devices. */
const tell = async (
  dependencies: ChannelWriteDependencies,
  userId: string,
  told: readonly Told[],
): Promise<void> => {
  const { clock, bus, log = NO_LOG } = dependencies;
  await publishAfterCommit(log, [
    told.map((channel) =>
      publication('CHANNEL_STATE', () =>
        publishChannelState(bus, clock, userId, channel.channelId, channel.state, channel.version),
      ),
    ),
  ]);
};
