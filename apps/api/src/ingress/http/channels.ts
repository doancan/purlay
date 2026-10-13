/**
 * The channel endpoints Phase 0 serves (`API.md` §4).
 *
 * Framework-neutral, like the rest: a request in, a decision out.
 *
 * Two route shapes, two guards. A channel named inside its workspace goes
 * through the membership guard and then the visibility guard; a channel named on
 * its own derives the workspace from the resource and does both (D-34).
 */
import type { Executor } from '@purlay/db';
import {
  AddChannelMemberRequest,
  CreateChannelRequest,
  CreateDirectMessageRequest,
  ReadChannelRequest,
  SetNotificationLevelRequest,
  UpdateChannelRequest,
  type Channel,
  type ChannelMemberList,
  type ReadChannelResponse,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireChannelById } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishAccessRevoked,
  publishChannelAdded,
  publishChannelRevoked,
  publishChannelState,
  publishChannelUpdated,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import {
  channelIn,
  channelsVisibleIn,
  createChannel,
  joinChannel,
} from '../../modules/channels/channels';
import { openDirectMessage } from '../../modules/channels/direct-messages';
import { addMember } from '../../modules/channels/members';
import { markRead } from '../../modules/channels/read-state';
import { setNotificationLevel } from '../../modules/channels/notification-level';
import {
  archiveChannel,
  channelMembers,
  leaveChannel,
  updateChannel,
} from '../../modules/channels/settings';
import { requireSession } from './session';
import { validated } from './validate';

export interface ChannelDependencies {
  readonly database: Executor;
  readonly clock: Clock;
}

/** What a write that tells other sockets needs as well. */
export interface ChannelWriteDependencies extends ChannelDependencies {
  readonly bus: EventBus;
  /** Where a failed publish is written; the write it follows is already committed. */
  readonly log?: Logger;
}

export const listChannels = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<readonly Channel[]> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await channelsVisibleIn(database, context);
};

export const createWorkspaceChannel = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<Channel> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(CreateChannelRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await createChannel(transaction, clock, context, input),
  );
};

export const readChannel = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<Channel> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelIn(database, context);
};

export const joinPublicChannel = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<Channel> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  await joinChannel(database, clock, context);
  return await channelIn(database, context);
};

/**
 * `PUT /api/channels/:channelId/read` — the person has read up to this message.
 *
 * The position and both counters move in one transaction; the person's other
 * devices are told after it commits, on their own topic, so a socket is never told
 * of a position that was rolled back (D-99 §4). A position that did not move **still
 * tells the caller's devices where they stand**, from the row as it is: a repeated read
 * usually means the answer, or the frame behind it, was lost, and this is what repairs it.
 * It is the caller's own topic, so nobody else hears anything (H-API 4).
 */
export const readUpTo = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<ReadChannelResponse> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(ReadChannelRequest, body);
  const outcome = await atomicallyOn(database)(
    async (transaction) => await markRead(transaction, clock, context, input.lastReadMessageId),
  );
  await publishAfterCommit(log, [
    [
      publication('CHANNEL_STATE', () =>
        publishChannelState(bus, clock, userId, channelId, outcome.state, outcome.version),
      ),
    ],
  ]);
  return outcome.state;
};

/**
 * `POST /api/workspaces/:workspaceId/dms` — the direct message with this person,
 * opened if it was not, and the same one if it was (I-5). The other person is told
 * only when this call is what created it.
 */
export const openDirectMessageWith = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<{ readonly channel: Channel; readonly created: boolean }> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(CreateDirectMessageRequest, body);
  const opened = await atomicallyOn(database)(
    async (transaction) => await openDirectMessage(transaction, clock, context, input.userId),
  );
  const forPeer = opened.forPeer;
  if (forPeer !== null) {
    await publishAfterCommit(log, [
      [publication('CHANNEL_ADDED', () => publishChannelAdded(bus, clock, input.userId, forPeer))],
    ]);
  }
  return { channel: opened.channel, created: opened.created };
};

/**
 * `POST /api/channels/:channelId/members` — a member brings somebody from the workspace in
 * (D-104). They are told only when this call is what added them, and their client subscribes on
 * hearing it.
 */
export const addChannelMember = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(AddChannelMemberRequest, body);
  const added = await atomicallyOn(database)(
    async (transaction) => await addMember(transaction, clock, context, input.userId),
  );
  const forMember = added.forMember;
  if (forMember !== null) {
    await publishAfterCommit(log, [
      [
        publication('CHANNEL_ADDED', () =>
          publishChannelAdded(bus, clock, input.userId, forMember),
        ),
      ],
    ]);
  }
};

/**
 * `PUT /api/channels/:channelId/notification-level` — what the caller is told about here (D-107).
 * Their own membership only; a channel they are not in is the stranger's `404`.
 */
export const setLevel = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<void> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(SetNotificationLevelRequest, body);
  await setNotificationLevel(database, context, input.level);
};

/**
 * `PATCH /api/channels/:channelId` — a member renames the channel or sets its topic (D-123). The
 * room hears the new name and topic after the commit, at the row's version; asking for what is
 * already there is answered and tells nobody.
 */
export const changeChannel = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<Channel> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(UpdateChannelRequest, body);
  const { channel, update } = await atomicallyOn(database)(
    async (transaction) => await updateChannel(transaction, clock, context, input),
  );
  if (update !== null) {
    await publishAfterCommit(log, [
      [
        publication('CHANNEL_UPDATED', () =>
          publishChannelUpdated(bus, clock, update, update.version),
        ),
      ],
    ]);
  }
  return channel;
};

/**
 * `DELETE /api/channels/:channelId` — an owner or an admin archives it (D-123). Everyone watching
 * it stops receiving it, on the channel's topic, and is told it was archived.
 */
export const archive = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  await atomicallyOn(database)(async (transaction) => {
    await archiveChannel(transaction, clock, context);
  });
  await publishAfterCommit(log, [
    [publication('ACCESS_REVOKED', () => publishChannelRevoked(bus, clock, channelId))],
  ]);
};

/**
 * `POST /api/channels/:channelId/leave` — out of the channel (D-123). The caller's own sockets stop
 * receiving it and are told they left; not being in it is the same `204`, and tells nobody.
 */
export const leave = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  const left = await atomicallyOn(database)(
    async (transaction) => await leaveChannel(transaction, context),
  );
  if (left) {
    await publishAfterCommit(log, [
      [
        publication('ACCESS_REVOKED', () =>
          publishAccessRevoked(bus, clock, userId, [channelId], 'left'),
        ),
      ],
    ]);
  }
};

/** `GET /api/channels/:channelId/members` — who is in it, for anybody who can see it (D-123). */
export const listChannelMembers = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<ChannelMemberList> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireChannelById(database, userId, channelId);
  return [...(await channelMembers(database, context))];
};
