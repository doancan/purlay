/** A star and a move repaint one shared confirmed channel, including across refused queued writes. */
import { sidebarLedger } from './sidebar-writes';
import type { Channel, MeResponse } from '@purlay/types';
import type { QueryClient } from '@tanstack/react-query';
import { keys } from './keys';

export const channelPlacementLedger = sidebarLedger<Channel>();

export const sidebarActor = (client: QueryClient): string | undefined =>
  client.getQueryData<MeResponse>(keys.me)?.user.id;

export const channelInCache = (client: QueryClient, channel: Channel): Channel =>
  client
    .getQueryData<Channel[]>(keys.channels(channel.workspaceId))
    ?.find((entry) => entry.id === channel.id) ?? channel;

export const paintChannelPlacement = (client: QueryClient, channel: Channel): void => {
  client.setQueryData<Channel[]>(keys.channels(channel.workspaceId), (channels) =>
    channels?.map((entry) =>
      entry.id === channel.id
        ? { ...entry, starred: channel.starred, sidebarGroupId: channel.sidebarGroupId }
        : entry,
    ),
  );
};
