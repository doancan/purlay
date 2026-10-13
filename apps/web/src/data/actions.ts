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
  Membership,
  UpdateChannelRequest,
  Message,
  Workspace,
} from '@purlay/types';
import type { Api } from './api';
import {
  channelAdded,
  channelRenamed,
  channelStateChanged,
  channelsRevoked,
  patchMessage,
  reactionsUpdated,
  threadUpdated,
  messageRevised,
} from './cache';
import { forgetPersonalData, type ClientStorage } from './browser-storage';
import { keys } from './keys';
import type { Clock } from '../realtime/clock';
import { systemClock } from '../system-clock';

export interface Actions {
  readonly react: (message: Message, emoji: string) => Promise<void>;
  readonly unreact: (message: Message, emoji: string) => Promise<void>;
  /** The caller's own message, new words: on screen at once, put back if refused (D-103). */
  readonly edit: (message: Message, content: string) => Promise<void>;
  /** A tombstone at once, or gone if nobody answered it; read again if refused (D-103 §7). */
  readonly remove: (message: Message) => Promise<void>;
  readonly resolve: (message: Message) => Promise<void>;
  readonly reopen: (message: Message) => Promise<void>;
  readonly markRead: (channelId: string, lastReadMessageId: string) => Promise<void>;
  readonly createChannel: (workspaceId: string, input: CreateChannelRequest) => Promise<Channel>;
  readonly joinChannel: (channelId: string) => Promise<Channel>;
  /** A new name or topic; the list shows what the server kept (D-123). */
  readonly updateChannel: (channelId: string, input: UpdateChannelRequest) => Promise<Channel>;
  /** Out of the channel; a public one stays to be seen and joined again (D-123). */
  readonly leaveChannel: (channel: Channel) => Promise<void>;
  /** An owner's or an admin's: gone for everyone (D-123). */
  readonly archiveChannel: (channelId: string) => Promise<void>;
  readonly openDirectMessage: (workspaceId: string, userId: string) => Promise<Channel>;
  readonly createWorkspace: (input: CreateWorkspaceRequest) => Promise<Workspace>;
  /** In by an invitation's token (D-115); answers the membership, already listed by `/api/me`. */
  readonly joinWorkspace: (token: string) => Promise<Membership>;
  readonly signOut: () => Promise<void>;
}

export const createActions = (
  api: Api,
  client: QueryClient,
  storage: ClientStorage | null = null,
  // The guess painted before the server answers is replaced by the server's own time.
  clock: Clock = systemClock,
): Actions => {
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
    edit: async (message, content): Promise<void> => {
      // Painted before the answer (CONTRIBUTING §1.9); the server's time and mentions replace it.
      const before = {
        content: message.content,
        editedAt: message.editedAt,
        mentions: message.mentions,
      };
      patchMessage(client, message.id, (m) => ({
        ...m,
        content,
        editedAt: clock.now().toISOString(),
      }));
      try {
        const saved = await api.editMessage(message.id, content);
        patchMessage(client, message.id, (m) => ({
          ...m,
          content: saved.content,
          editedAt: saved.editedAt,
          mentions: saved.mentions,
        }));
      } catch (error) {
        patchMessage(client, message.id, (m) => ({ ...m, ...before }));
        throw error;
      }
    },
    remove: async (message): Promise<void> => {
      // The same revision the server will tell the room, applied by the same rule.
      messageRevised(client, {
        channelId: message.channelId,
        messageId: message.id,
        parentId: message.parentId,
        content: '',
        editedAt: message.editedAt,
        deletedAt: clock.now().toISOString(),
        mentions: [],
      });
      try {
        await api.deleteMessage(message.id);
      } catch (error) {
        // A message taken off the screen cannot be put back from here: read the truth again.
        void client.invalidateQueries({ queryKey: keys.messages(message.channelId) });
        if (message.parentId !== null) {
          void client.invalidateQueries({ queryKey: keys.thread(message.parentId) });
        }
        throw error;
      }
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
    updateChannel: async (channelId, input): Promise<Channel> => {
      const channel = await api.updateChannel(channelId, input);
      channelRenamed(client, channelId, { name: channel.name ?? '', topic: channel.topic });
      // The answer carries no version: a rename that committed after this one may have been
      // painted by its frame first, and this would hide it. The list read again settles on the
      // server's (D-123 §6).
      void client.invalidateQueries({ queryKey: keys.channels(channel.workspaceId) });
      return channel;
    },
    leaveChannel: async (channel): Promise<void> => {
      await api.leaveChannel(channel.id);
      channelsRevoked(client, [channel.id]);
      // A public channel is still there to see, as one not joined: the list is read again.
      if (channel.type === 'public') {
        await client.invalidateQueries({ queryKey: keys.channels(channel.workspaceId) });
      }
    },
    archiveChannel: async (channelId): Promise<void> => {
      await api.archiveChannel(channelId);
      channelsRevoked(client, [channelId]);
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
    joinWorkspace: async (token): Promise<Membership> => {
      const membership = await api.acceptInvitation(token);
      // A new membership: the identity answer lists it, so ask again before going there.
      await client.invalidateQueries({ queryKey: keys.me });
      return membership;
    },
    signOut: async (): Promise<void> => {
      await api.signOut();
      // Nothing cached belongs to the next person to sign in on this page — nor does anything
      // they wrote that the browser kept: a draft is keyed by channel and thread ids alone, so
      // the next person opening the same conversation would otherwise find it.
      client.clear();
      forgetPersonalData(storage);
    },
  };
};
