/**
 * The channel endpoints Phase 0 serves (`API.md` §4).
 *
 * Framework-neutral, like the rest: a request in, a decision out.
 *
 * Two route shapes, two guards. A channel named inside its workspace goes
 * through the membership guard and then the visibility guard; a channel named on
 * its own derives the workspace from the resource and does both (D-34).
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { Auth } from '../../../modules/auth/better-auth';
import {
  AddChannelMemberRequest,
  CreateChannelRequest,
  OpenConversationRequest,
  CreateDirectMessageRequest,
  ReadChannelRequest,
  MarkUnreadRequest,
  SetChannelRetentionRequest,
  SetNotificationLevelRequest,
  UpdateChannelRequest,
  type ArchivedChannel,
  type Channel,
  type ChannelRetention,
  type ChannelMemberList,
  type ReadAllChannelsResponse,
  type ReadChannelResponse,
} from '@purlay/types';
import type { Clock } from '../../../platform/clock';
import { requireChannelById } from '../channels/guard';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishAccessRevoked,
  publishChannelAdded,
  publishChannelsUpdated,
  publishChannelRevoked,
  publishChannelState,
  publishChannelUpdated,
  type EventBus,
} from '../../../platform/events';
import type { Logger } from '../../../platform/logging';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import { channelIn, channelsVisibleIn, createChannel, joinChannel } from '../channels/channels';
import { openConversation, openDirectMessage } from '../channels/direct-messages';
import { addMember } from '../channels/members';
import { markAllRead, markRead, markUnread } from '../channels/read-state';
import { setNotificationLevel } from '../channels/notification-level';
import { readChannelRetention, setChannelRetention } from '../channels/retention';
import {
  archiveChannel,
  archivedChannels,
  channelMembers,
  leaveChannel,
  removeChannelMember,
  restoreChannel,
  updateChannel,
} from '../channels/settings';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';

export interface ChannelDependencies {
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: Auth;
  readonly database: ModuleRouteDependencies['database'];
  readonly clock: Clock;
}

/** What a write that tells other sockets needs as well. */
export interface ChannelWriteDependencies extends ChannelDependencies {
  readonly bus: EventBus;
  /** Where a failed publish is written; the write it follows is already committed. */
  readonly log?: Logger;
}

const listChannels = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<readonly Channel[]> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await channelsVisibleIn(database, context);
};

/**
 * `POST /api/workspaces/:workspaceId/channels` — made, and its maker in it. Their other devices are
 * told, as leaving tells them (#540): without it a channel made on one is missing on the rest.
 */
export const createWorkspaceChannel = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<Channel> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(CreateChannelRequest, body);
  const made = await atomicallyOn(database)(
    async (transaction) => await createChannel(transaction, clock, context, input),
  );
  await publishAfterCommit(log, [
    [publication('CHANNEL_ADDED', () => publishChannelAdded(bus, clock, userId, made))],
  ]);
  return made;
};

const readChannel = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<Channel> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await channelIn(database, context);
};

/**
 * `POST /api/channels/:channelId/join` — a public channel joined. The person's other devices are
 * told when this call is what joined it, as leaving tells them (#540): without it the channel, its
 * unread and its mentions are missing on every other open page until it is reloaded.
 */
export const joinPublicChannel = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
): Promise<Channel> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const joined = await joinChannel(database, clock, context);
  const channel = await channelIn(database, context);
  if (joined) {
    await publishAfterCommit(log, [
      [publication('CHANNEL_ADDED', () => publishChannelAdded(bus, clock, userId, channel))],
    ]);
  }
  return channel;
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
  const { userId } = await requireSession(dependencies.auth, request);
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
 * `PUT /api/channels/:channelId/unread` — "mark unread from here" (D-212). The caller's devices are
 * told, from the row as it is, whether or not it moved, as a read tells them.
 */
const unreadFrom = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<ReadChannelResponse> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(MarkUnreadRequest, body);
  const outcome = await atomicallyOn(database)(
    async (transaction) => await markUnread(transaction, context, input.fromMessageId),
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
 * `PUT /api/workspaces/:workspaceId/read` — every channel the caller is in, read to its newest message
 * (D-238). One transaction; after it commits, each channel answered is told to the caller's devices on
 * their own topic, as a read of one channel tells them — whether or not it moved, so a repeat repairs a
 * device that missed the first.
 */
const readAllChannels = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
): Promise<ReadAllChannelsResponse> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const outcomes = await atomicallyOn(database)(
    async (transaction) => await markAllRead(transaction, clock, context),
  );
  await publishAfterCommit(log, [
    outcomes.map((outcome) =>
      publication('CHANNEL_STATE', () =>
        publishChannelState(bus, clock, userId, outcome.channelId, outcome.state, outcome.version),
      ),
    ),
  ]);
  return { data: outcomes.map(({ channelId, state }) => ({ channelId, state })) };
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
  const { userId } = await requireSession(dependencies.auth, request);
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
 * `POST /api/workspaces/:workspaceId/conversations` — the conversation with these people, opened
 * if it was not and the same one if it was (I-5, D-127). Each other person is told only when this
 * call created it, after the commit.
 */
export const openConversationWith = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<{ readonly channel: Channel; readonly created: boolean }> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(OpenConversationRequest, body);
  const opened = await atomicallyOn(database)(
    async (transaction) => await openConversation(transaction, clock, context, input.userIds),
  );
  await publishAfterCommit(log, [
    opened.forOthers.map((other) =>
      publication('CHANNEL_ADDED', () =>
        publishChannelAdded(bus, clock, other.userId, other.channel),
      ),
    ),
  ]);
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
  const { userId } = await requireSession(dependencies.auth, request);
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
const setLevel = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<void> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const input = validated(SetNotificationLevelRequest, body);
  await setNotificationLevel(database, context, input.level);
};

/**
 * `PATCH /api/channels/:channelId` — a member renames the channel or sets its topic (D-123). The
 * room hears the new name and topic after the commit, at the row's version; asking for what is
 * already there is answered and tells nobody.
 */
const changeChannel = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<Channel> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
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
const archive = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  await atomicallyOn(database)(async (transaction) => {
    await archiveChannel(transaction, clock, context);
  });
  await publishAfterCommit(log, [
    [publication('ACCESS_REVOKED', () => publishChannelRevoked(bus, clock, channelId))],
  ]);
};

/**
 * `GET /api/workspaces/:workspaceId/archived-channels` — the archived channels this owner or admin may
 * bring back, the most recently archived first (D-232).
 */
const listArchived = async (
  dependencies: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<readonly ArchivedChannel[]> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await archivedChannels(database, context);
};

/**
 * `POST /api/channels/:channelId/restore` — an owner or an admin brings an archived channel back
 * (D-232). Each of its members reads their channels again, so it returns to their sidebars at once.
 */
const restore = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const restored = await atomicallyOn(database)(
    async (transaction) => await restoreChannel(transaction, clock, userId, channelId),
  );
  await publishAfterCommit(log, [
    restored.memberIds.map((memberId) =>
      publication('CHANNELS_UPDATED', () =>
        publishChannelsUpdated(bus, clock, memberId, restored.workspaceId),
      ),
    ),
  ]);
};

/**
 * `POST /api/channels/:channelId/leave` — out of the channel (D-123). The caller's own sockets stop
 * receiving it and are told they left; not being in it is the same `204`, and tells nobody.
 */
const leave = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
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

/**
 * `DELETE /api/channels/:channelId/members/:userId` — somebody taken out of the channel (D-172), or
 * the caller leaving it by naming themself. The person's own sockets stop receiving it and are told
 * why; not being in it is the same `204`, and tells nobody.
 */
const removeFromChannel = async (
  dependencies: ChannelWriteDependencies,
  request: Request,
  channelId: string,
  memberId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const removal = await atomicallyOn(database)(
    async (transaction) => await removeChannelMember(transaction, clock, context, memberId),
  );
  if (removal !== null) {
    await publishAfterCommit(log, [
      [
        publication('ACCESS_REVOKED', () =>
          publishAccessRevoked(bus, clock, memberId, [channelId], removal),
        ),
      ],
    ]);
  }
};

/** `GET /api/channels/:channelId/members` — who is in it, for anybody who can see it (D-123). */
const listChannelMembers = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<ChannelMemberList> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return [...(await channelMembers(database, context))];
};

/**
 * `GET /api/channels/:channelId/retention` — how long the channel keeps its history beside its
 * workspace's window, and what is kept: an owner's (D-225).
 */
const readChannelRetentionSetting = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
): Promise<ChannelRetention> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  return await readChannelRetention(database, context);
};

/**
 * `PUT /api/channels/:channelId/retention` — an owner lets the channel keep its history longer than
 * the workspace does, or follow it again (D-225). Nothing is told to any socket: only an owner reads it,
 * as the workspace's window (D-139 §4).
 */
const updateChannelRetentionSetting = async (
  dependencies: ChannelDependencies,
  request: Request,
  channelId: string,
  body: unknown,
): Promise<ChannelRetention> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireChannelById(database, userId, channelId);
  const { keepsAtLeast } = validated(SetChannelRetentionRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await setChannelRetention(transaction, clock, context, keepsAtLeast),
  );
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const channelRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .get(
      '/api/workspaces/:workspaceId/channels',
      async ({ request, params }) => await listChannels(context, request, params.workspaceId),
    )
    .get(
      '/api/workspaces/:workspaceId/archived-channels',
      async ({ request, params }) => await listArchived(context, request, params.workspaceId),
    )
    .put(
      '/api/workspaces/:workspaceId/read',
      async ({ request, params }) => await readAllChannels(context, request, params.workspaceId),
    )
    .post('/api/workspaces/:workspaceId/channels', async ({ request, params, body, set }) => {
      set.status = 201;
      return await createWorkspaceChannel(context, request, params.workspaceId, body);
    })
    .post('/api/workspaces/:workspaceId/conversations', async ({ request, params, body, set }) => {
      const { channel, created } = await openConversationWith(
        context,
        request,
        params.workspaceId,
        body,
      );
      // As `/dms`: 201 when this call made it, 200 when these people already had it (I-5).
      set.status = created ? 201 : 200;
      return channel;
    })
    .post('/api/workspaces/:workspaceId/dms', async ({ request, params, body, set }) => {
      const { channel, created } = await openDirectMessageWith(
        context,
        request,
        params.workspaceId,
        body,
      );
      // 201 when this call made it, 200 when it was already there: the same pair
      // is the same channel, and a retry is not a second one (I-5).
      set.status = created ? 201 : 200;
      return channel;
    })
    .get(
      '/api/channels/:channelId',
      async ({ request, params }) => await readChannel(context, request, params.channelId),
    )
    .patch(
      '/api/channels/:channelId',
      async ({ request, params, body }) =>
        await changeChannel(context, request, params.channelId, body),
    )
    .get(
      '/api/channels/:channelId/retention',
      async ({ request, params }) =>
        await readChannelRetentionSetting(context, request, params.channelId),
    )
    .put(
      '/api/channels/:channelId/retention',
      async ({ request, params, body }) =>
        await updateChannelRetentionSetting(context, request, params.channelId, body),
    )
    .delete('/api/channels/:channelId', async ({ request, params, set }) => {
      await archive(context, request, params.channelId);
      set.status = 204;
      return null;
    })
    .post('/api/channels/:channelId/restore', async ({ request, params, set }) => {
      await restore(context, request, params.channelId);
      set.status = 204;
      return null;
    })
    .post('/api/channels/:channelId/leave', async ({ request, params, set }) => {
      await leave(context, request, params.channelId);
      set.status = 204;
      return null;
    })
    .delete('/api/channels/:channelId/members/:userId', async ({ request, params, set }) => {
      await removeFromChannel(context, request, params.channelId, params.userId);
      set.status = 204;
      return null;
    })
    .get(
      '/api/channels/:channelId/members',
      async ({ request, params }) => await listChannelMembers(context, request, params.channelId),
    )
    .put(
      '/api/channels/:channelId/read',
      async ({ request, params, body }) => await readUpTo(context, request, params.channelId, body),
    )
    .put(
      '/api/channels/:channelId/unread',
      async ({ request, params, body }) =>
        await unreadFrom(context, request, params.channelId, body),
    )
    .put('/api/channels/:channelId/notification-level', async ({ request, params, body, set }) => {
      await setLevel(context, request, params.channelId, body);
      set.status = 204;
      return null;
    })
    .post('/api/channels/:channelId/members', async ({ request, params, body, set }) => {
      await addChannelMember(context, request, params.channelId, body);
      set.status = 204;
      return null;
    })
    .post(
      '/api/channels/:channelId/join',
      async ({ request, params }) => await joinPublicChannel(context, request, params.channelId),
    );
