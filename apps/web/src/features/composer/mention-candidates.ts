/**
 * Who the `@` list may offer in one channel — the people a mention written there would reach
 * (`resolveMentions`, `apps/api/src/modules/messages/delivery.ts`).
 *
 * - **A public channel:** everybody in the workspace. The server resolves a name there workspace-wide.
 * - **A direct message:** the other person.
 * - **A private channel:** its members now (`GET /api/channels/:id/members`, D-123), and still in the
 *   workspace. The server tells nobody outside a private channel, so offering anybody else there would
 *   offer a name it silently drops; and while the members are being read, nobody rather than a guess.
 */
import { useCallback } from 'react';
import type { Channel, User, WorkspaceMember } from '@purlay/types';
import { useChannelMembers, useChannels, useMembers } from '../../data/queries';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { offerable } from './mention-suggest';

/** The pure half, so a test can hold it without a provider tree. */
export const candidatesFor = (
  channel: Channel | undefined,
  members: readonly WorkspaceMember[],
  inChannel: readonly User[] | undefined,
  selfId: string,
): readonly User[] => {
  if (channel === undefined) return [];
  const people = members.map((member) => member.user);
  if (channel.type === 'public') return offerable(people, selfId);
  // A direct message's people are its key's (D-127): two, or a group — offered while they are
  // still people of the workspace.
  if (channel.type === 'direct_message') {
    const its = new Set(channel.peers.map((person) => person.id));
    return offerable(
      people.filter((person) => its.has(person.id)),
      selfId,
    );
  }
  if (inChannel === undefined) return [];
  const here = new Set(inChannel.map((person) => person.id));
  return offerable(
    people.filter((person) => here.has(person.id)),
    selfId,
  );
};

/** Who may be offered, and whether that is known yet: a private channel's members are read first. */
export interface MentionCandidates {
  readonly people: readonly User[];
  readonly state: 'ready' | 'reading' | 'failed';
  /** Read the channel's members again: after a failure, or when a new `@` finds them stale. */
  readonly refresh: () => void;
}

export const useMentionCandidates = (channelId: string): MentionCandidates => {
  const { workspace } = useWorkspace();
  const session = useSession();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const channel = channels.data?.find((each) => each.id === channelId);
  const isPrivate = channel?.type === 'private';
  const inChannel = useChannelMembers(channelId, isPrivate);
  const { refetch, isStale } = inChannel;
  const refresh = useCallback((): void => {
    if (isPrivate && isStale) void refetch();
  }, [isPrivate, isStale, refetch]);
  return {
    people: candidatesFor(
      channel,
      members.data ?? [],
      inChannel.data?.map((member) => member.user),
      session.user.id,
    ),
    state:
      !isPrivate || inChannel.data !== undefined
        ? 'ready'
        : inChannel.isError
          ? 'failed'
          : 'reading',
    refresh,
  };
};
