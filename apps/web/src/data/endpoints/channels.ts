// Channels and what a member keeps in them: groups, members, pins, bookmarks, files, direct messages.
import {
  ArchivedChannelList,
  BookmarkList,
  CHANNEL_GROUP_LIMIT,
  Channel,
  ChannelBookmark,
  ChannelGroup,
  ChannelGroupPage,
  ChannelList,
  ChannelMemberList,
  FilePage,
  PinList,
  type AddBookmarkRequest,
  type CreateChannelRequest,
  type NotificationLevel,
  type UpdateChannelRequest,
} from '@purlay/types';
import type { Http } from '../http';
import { at, options } from './request';

export interface ChannelsApi {
  readonly channels: (workspaceId: string, signal?: AbortSignal) => Promise<ChannelList>;
  readonly channelGroups: (workspaceId: string, signal?: AbortSignal) => Promise<ChannelGroupPage>;
  readonly saveChannelGroup: (
    workspaceId: string,
    groupId: string,
    name: string,
  ) => Promise<ChannelGroup>;
  readonly foldChannelGroup: (
    workspaceId: string,
    groupId: string,
    collapsed: boolean,
  ) => Promise<ChannelGroup>;
  readonly removeChannelGroup: (workspaceId: string, groupId: string) => Promise<void>;
  readonly moveChannelGroup: (channelId: string, groupId: string | null) => Promise<Channel>;
  readonly createChannel: (workspaceId: string, input: CreateChannelRequest) => Promise<Channel>;
  readonly joinChannel: (channelId: string) => Promise<Channel>;
  /** A member's: a new name or topic, answered with the channel as it now is (D-123). */
  readonly updateChannel: (channelId: string, input: UpdateChannelRequest) => Promise<Channel>;
  /** An owner's or an admin's: archived, for everyone (D-123). */
  readonly archiveChannel: (channelId: string) => Promise<void>;
  /** An owner's or an admin's: the archived channels they may bring back (D-232). */
  readonly archivedChannels: (
    workspaceId: string,
    signal?: AbortSignal,
  ) => Promise<ArchivedChannelList>;
  /** An owner's or an admin's: an archived channel brought back, as it was (D-232). */
  readonly restoreChannel: (channelId: string) => Promise<void>;
  readonly leaveChannel: (channelId: string) => Promise<void>;
  /** Who is in the channel (D-123). */
  readonly channelMembers: (channelId: string, signal?: AbortSignal) => Promise<ChannelMemberList>;
  /** Brings somebody from the workspace into the channel (D-104); they are told by the server. */
  readonly addChannelMember: (channelId: string, userId: string) => Promise<void>;
  /** Takes somebody out of the channel (D-172); they are told by the server. */
  readonly removeChannelMember: (channelId: string, userId: string) => Promise<void>;
  /** What the caller is told about in this channel (D-107). */
  readonly setNotificationLevel: (channelId: string, level: NotificationLevel) => Promise<void>;
  /** Stars a channel the caller is in, or lets the star go (D-132). */
  readonly star: (channelId: string, starred: boolean) => Promise<void>;
  readonly openDirectMessage: (workspaceId: string, userId: string) => Promise<Channel>;
  /** The conversation of the caller and these people, opened or made (D-127). */
  readonly openConversation: (workspaceId: string, userIds: readonly string[]) => Promise<Channel>;
  /** A channel's pins, newest first (D-130). */
  readonly pins: (channelId: string, signal?: AbortSignal) => Promise<PinList>;
  /** Pins a message for its channel, or lets the pin go (D-130). */
  readonly pin: (messageId: string) => Promise<void>;
  readonly unpin: (messageId: string) => Promise<void>;
  /** A channel's bookmarks, oldest first (D-218). */
  readonly bookmarks: (channelId: string, signal?: AbortSignal) => Promise<BookmarkList>;
  /** A member keeps a link at hand; the same address again answers the bookmark already there. */
  readonly addBookmark: (channelId: string, input: AddBookmarkRequest) => Promise<ChannelBookmark>;
  readonly removeBookmark: (channelId: string, bookmarkId: string) => Promise<void>;
  /** A channel's files, newest message first; older than `before`, a file's id (D-129). */
  readonly files: (channelId: string, before?: string, signal?: AbortSignal) => Promise<FilePage>;
}

export const createChannelsApi = (http: Http): ChannelsApi => ({
  channels: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/channels`,
      ChannelList,
      options({}, signal),
    ),
  channelGroups: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/channel-groups`,
      ChannelGroupPage,
      options({ query: { limit: CHANNEL_GROUP_LIMIT } }, signal),
    ),
  saveChannelGroup: (workspaceId, groupId, name) =>
    http.request(
      'PUT',
      `/api/workspaces/${at(workspaceId)}/channel-groups/${at(groupId)}`,
      ChannelGroup,
      { body: { name } },
    ),
  foldChannelGroup: (workspaceId, groupId, collapsed) =>
    http.request(
      'PATCH',
      `/api/workspaces/${at(workspaceId)}/channel-groups/${at(groupId)}`,
      ChannelGroup,
      { body: { collapsed } },
    ),
  removeChannelGroup: (workspaceId, groupId) =>
    http.send('DELETE', `/api/workspaces/${at(workspaceId)}/channel-groups/${at(groupId)}`),
  moveChannelGroup: (channelId, groupId) =>
    http.request('PUT', `/api/channels/${at(channelId)}/sidebar-group`, Channel, {
      body: { groupId },
    }),
  createChannel: (workspaceId, input) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/channels`,
      Channel,
      options({ body: input }),
    ),
  joinChannel: (channelId) =>
    http.request('POST', `/api/channels/${at(channelId)}/join`, Channel, options()),
  updateChannel: (channelId, input) =>
    http.request('PATCH', `/api/channels/${at(channelId)}`, Channel, options({ body: input })),
  archiveChannel: (channelId) => http.send('DELETE', `/api/channels/${at(channelId)}`, options()),
  archivedChannels: (workspaceId, signal) =>
    http.request(
      'GET',
      `/api/workspaces/${at(workspaceId)}/archived-channels`,
      ArchivedChannelList,
      options({}, signal),
    ),
  restoreChannel: (channelId) =>
    http.send('POST', `/api/channels/${at(channelId)}/restore`, options()),
  leaveChannel: (channelId) => http.send('POST', `/api/channels/${at(channelId)}/leave`, options()),
  channelMembers: (channelId, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/members`,
      ChannelMemberList,
      options({}, signal),
    ),
  addChannelMember: (channelId, userId) =>
    http.send('POST', `/api/channels/${at(channelId)}/members`, options({ body: { userId } })),
  removeChannelMember: (channelId, userId) =>
    http.send('DELETE', `/api/channels/${at(channelId)}/members/${at(userId)}`, options()),
  setNotificationLevel: (channelId, level) =>
    http.send(
      'PUT',
      `/api/channels/${at(channelId)}/notification-level`,
      options({ body: { level } }),
    ),
  star: (channelId, starred) =>
    http.send(starred ? 'PUT' : 'DELETE', `/api/channels/${at(channelId)}/star`, options()),
  openDirectMessage: (workspaceId, userId) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/dms`,
      Channel,
      options({ body: { userId } }),
    ),
  openConversation: (workspaceId, userIds) =>
    http.request(
      'POST',
      `/api/workspaces/${at(workspaceId)}/conversations`,
      Channel,
      options({ body: { userIds } }),
    ),
  pins: (channelId, signal) =>
    http.request('GET', `/api/channels/${at(channelId)}/pins`, PinList, options({}, signal)),
  pin: (messageId) => http.send('PUT', `/api/messages/${at(messageId)}/pin`, options()),
  unpin: (messageId) => http.send('DELETE', `/api/messages/${at(messageId)}/pin`, options()),
  bookmarks: (channelId, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/bookmarks`,
      BookmarkList,
      options({}, signal),
    ),
  addBookmark: (channelId, input) =>
    http.request(
      'POST',
      `/api/channels/${at(channelId)}/bookmarks`,
      ChannelBookmark,
      options({ body: input }),
    ),
  removeBookmark: (channelId, bookmarkId) =>
    http.send('DELETE', `/api/channels/${at(channelId)}/bookmarks/${at(bookmarkId)}`, options()),
  files: (channelId, before, signal) =>
    http.request(
      'GET',
      `/api/channels/${at(channelId)}/files`,
      FilePage,
      options(before === undefined ? {} : { query: { before } }, signal),
    ),
});
