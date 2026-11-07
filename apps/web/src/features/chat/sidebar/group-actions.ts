/** Editing and channel placement are loaded with the sidebar dialogs, after the first frame. */
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, ChannelGroup, ChannelGroupPage } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { keys } from '../../../data/keys';
import {
  channelInCache,
  channelPlacementLedger,
  paintChannelPlacement,
  sidebarActor,
} from '../../../data/channel-placement';
import { useWorkspace } from '../../shell/workspace';
import { sidebarLedger } from '../../../data/sidebar-writes';

type GroupChange = (
  id: string,
  apply: (value: ChannelGroup | undefined) => ChannelGroup | undefined,
  write: () => Promise<ChannelGroup | undefined>,
) => Promise<void>;

const groupsLedger = sidebarLedger<ChannelGroup | undefined>();

const useGroupChange = (): GroupChange => {
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const actor = sidebarActor(client);
  const actorKey = actor ?? 'no-session';
  const sameActor = (): boolean => sidebarActor(client) === actor;
  const checkActor = (): void => {
    if (!sameActor()) throw new Error('The signed-in account changed.');
  };
  const groupKey = keys.channelGroups(workspace.id);
  const channelsKey = keys.channels(workspace.id);
  const refresh = (): void => {
    if (!sameActor()) return;
    void client.invalidateQueries({ queryKey: groupKey });
    void client.invalidateQueries({ queryKey: channelsKey });
  };
  const change = async (
    id: string,
    apply: (value: ChannelGroup | undefined) => ChannelGroup | undefined,
    write: () => Promise<ChannelGroup | undefined>,
  ): Promise<void> => {
    checkActor();
    void client.cancelQueries({ queryKey: groupKey });
    await groupsLedger.send({
      client,
      key: `${actorKey}:${workspace.id}:${id}`,
      queueKey: `${actorKey}:groups:${workspace.id}`,
      read: () =>
        client.getQueryData<ChannelGroupPage>(groupKey)?.data.find((group) => group.id === id),
      paint: (group) => {
        if (!sameActor()) return;
        client.setQueryData<ChannelGroupPage>(groupKey, (before) => ({
          data: [
            ...(before?.data ?? []).filter((entry) => entry.id !== id),
            ...(group === undefined ? [] : [group]),
          ],
          nextCursor: null,
        }));
      },
      apply,
      write: async () => {
        checkActor();
        return await write();
      },
      accepted: (_value, answer) => answer,
      refresh,
    });
  };
  return change;
};

const useFoldGroup = (): ((group: ChannelGroup) => Promise<void>) => {
  const change = useGroupChange();
  const api = useApi();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  return async (group): Promise<void> => {
    const current =
      client
        .getQueryData<ChannelGroupPage>(keys.channelGroups(workspace.id))
        ?.data.find((entry) => entry.id === group.id) ?? group;
    const collapsed = !current.collapsed;
    await change(
      group.id,
      (before) => ({ ...(before ?? current), collapsed }),
      async () => await api.foldChannelGroup(workspace.id, group.id, collapsed),
    );
  };
};

interface GroupActions {
  readonly fold: (group: ChannelGroup) => Promise<void>;
  readonly save: (id: string, name: string) => Promise<void>;
  readonly remove: (group: ChannelGroup) => Promise<void>;
  readonly move: (channel: Channel, groupId: string | null) => Promise<void>;
}

export const useGroupActions = (): GroupActions => {
  const change = useGroupChange();
  const fold = useFoldGroup();
  const api = useApi();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const actor = sidebarActor(client);
  const actorKey = actor ?? 'no-session';
  const sameActor = (): boolean => sidebarActor(client) === actor;
  const checkActor = (): void => {
    if (!sameActor()) throw new Error('The signed-in account changed.');
  };
  const channelsKey = keys.channels(workspace.id);
  const refresh = (): void => {
    if (!sameActor()) return;
    void client.invalidateQueries({ queryKey: keys.channelGroups(workspace.id) });
    void client.invalidateQueries({ queryKey: channelsKey });
  };
  return {
    fold,
    save: async (id, name): Promise<void> => {
      await change(
        id,
        (before) => ({ id, name: name.trim(), collapsed: before?.collapsed ?? false }),
        async () => await api.saveChannelGroup(workspace.id, id, name),
      );
    },
    remove: async (group): Promise<void> => {
      await change(
        group.id,
        () => undefined,
        async () => {
          await api.removeChannelGroup(workspace.id, group.id);
          return undefined;
        },
      );
    },
    move: async (channel, groupId): Promise<void> => {
      checkActor();
      void client.cancelQueries({ queryKey: channelsKey });
      await channelPlacementLedger.send({
        client,
        key: `${actorKey}:${channel.id}`,
        queueKey: `${actorKey}:${channel.id}`,
        read: () => channelInCache(client, channel),
        paint: (value) => {
          if (sameActor()) paintChannelPlacement(client, value);
        },
        apply: (before) => ({ ...before, sidebarGroupId: groupId, starred: false }),
        write: async () => {
          checkActor();
          return await api.moveChannelGroup(channel.id, groupId);
        },
        accepted: (_value, answer) => answer,
        refresh,
      });
    },
  };
};
