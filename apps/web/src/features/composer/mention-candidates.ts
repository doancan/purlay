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
  if (channel.type === 'direct_message')
    return channel.peer === null ? [] : offerable([channel.peer], selfId);
  if (inChannel === undefined) return [];
  const here = new Set(inChannel.map((person) => person.id));
  return offerable(
    people.filter((person) => here.has(person.id)),
    selfId,
  );
};

export const useMentionCandidates = (channelId: string): readonly User[] => {
  const { workspace } = useWorkspace();
  const session = useSession();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const channel = channels.data?.find((each) => each.id === channelId);
  const inChannel = useChannelMembers(channelId, channel?.type === 'private');
  return candidatesFor(
    channel,
    members.data ?? [],
    inChannel.data?.map((member) => member.user),
    session.user.id,
  );
};
