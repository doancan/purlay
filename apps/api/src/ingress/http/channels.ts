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
  CreateChannelRequest,
  CreateDirectMessageRequest,
  ReadChannelRequest,
  type Channel,
  type ReadChannelResponse,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireChannelById } from '../../platform/channels';
import {
  NO_LOG,
  publication,
  publishAfterCommit,
  publishChannelAdded,
  publishChannelState,
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
import { markRead } from '../../modules/channels/read-state';
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
