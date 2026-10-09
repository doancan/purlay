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
import { CreateChannelRequest, type Channel } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireChannelById } from '../../platform/channels';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import {
  channelIn,
  channelsVisibleIn,
  createChannel,
  joinChannel,
} from '../../modules/channels/channels';
import { requireSession } from './session';
import { validated } from './validate';

export interface ChannelDependencies {
  readonly database: Executor;
  readonly clock: Clock;
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
