/**
 * What a person does, as one function each: ask the API, then teach the cache the
 * answer.
 *
 * The cache learns from the **response**, not from a guess made before it: a
 * reaction, a resolution and a read position come back as the server's whole truth
 * (`ReactionsResponse`, `Message`, `ReadChannelResponse`), and `cache.ts` copies it
 * in. That is slower than painting a guess by one round trip and wrong never — and
 * the one action that must not wait, sending a message, is not here: it is the
 * realtime engine's, with an optimistic row (`ARCHITECTURE.md` §5.3).
 *
 * A failure is thrown as the `ApiError` it is and changes nothing: the cache is
 * only written on success, so there is nothing to roll back.
 */
import type { QueryClient } from '@tanstack/react-query';
import type {
  Channel,
  CreateChannelRequest,
  CreateWorkspaceRequest,
  Message,
  Workspace,
} from '@purlay/types';
import type { Api } from './api';
import {
  channelAdded,
  channelStateChanged,
  patchMessage,
  reactionsUpdated,
  threadUpdated,
} from './cache';
import { keys } from './keys';

export interface Actions {
  readonly react: (message: Message, emoji: string) => Promise<void>;
  readonly unreact: (message: Message, emoji: string) => Promise<void>;
  readonly resolve: (message: Message) => Promise<void>;
  readonly reopen: (message: Message) => Promise<void>;
  readonly markRead: (channelId: string, lastReadMessageId: string) => Promise<void>;
  readonly createChannel: (workspaceId: string, input: CreateChannelRequest) => Promise<Channel>;
  readonly joinChannel: (channelId: string) => Promise<Channel>;
  readonly openDirectMessage: (workspaceId: string, userId: string) => Promise<Channel>;
  readonly createWorkspace: (input: CreateWorkspaceRequest) => Promise<Workspace>;
  readonly signOut: () => Promise<void>;
}

export const createActions = (api: Api, client: QueryClient): Actions => {
  const settled = (updated: Message): void => {
    // The root as the server now has it, in every list that shows it; and the
    // summary is what the open-questions view filters on.
    patchMessage(client, updated.id, () => updated);
    if (updated.thread !== null) threadUpdated(client, updated.id, updated.thread);
  };

  return {
    react: async (message, emoji): Promise<void> => {
      const { reactions } = await api.react(message.id, emoji);
      reactionsUpdated(client, message.id, reactions);
    },
    unreact: async (message, emoji): Promise<void> => {
      const { reactions } = await api.unreact(message.id, emoji);
      reactionsUpdated(client, message.id, reactions);
    },
    resolve: async (message): Promise<void> => {
      settled(await api.resolve(message.id));
    },
    reopen: async (message): Promise<void> => {
      settled(await api.reopen(message.id));
    },
    markRead: async (channelId, lastReadMessageId): Promise<void> => {
      channelStateChanged(client, channelId, await api.markRead(channelId, lastReadMessageId));
    },
    createChannel: async (workspaceId, input): Promise<Channel> => {
      const channel = await api.createChannel(workspaceId, input);
      channelAdded(client, channel);
      return channel;
    },
    joinChannel: async (channelId): Promise<Channel> => {
      const channel = await api.joinChannel(channelId);
      channelAdded(client, channel);
      return channel;
    },
    openDirectMessage: async (workspaceId, userId): Promise<Channel> => {
      const channel = await api.openDirectMessage(workspaceId, userId);
      channelAdded(client, channel);
      return channel;
    },
    createWorkspace: async (input): Promise<Workspace> => {
      const workspace = await api.createWorkspace(input);
      // A new membership: the identity answer lists it, so ask again.
      await client.invalidateQueries({ queryKey: keys.me });
      return workspace;
    },
    signOut: async (): Promise<void> => {
      await api.signOut();
      // Nothing cached belongs to the next person to sign in on this page.
      client.clear();
    },
  };
};
