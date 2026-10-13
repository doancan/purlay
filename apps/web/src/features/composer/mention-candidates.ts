/**
 * Who the `@` list may offer in one channel — the people a mention written there would reach
 * (`resolveMentions`, `apps/api/src/modules/messages/delivery.ts`), from what the client already
 * holds and never from an endpoint of its own (D-110 §8).
 *
 * - **A public channel:** everybody in the workspace. The server resolves a name there workspace-wide.
 * - **A direct message:** the other person.
 * - **A private channel:** only the people the client *knows* are in it — whoever wrote, or was
 *   named in, what it has loaded of the channel and its threads — and still in the workspace. The
 *   server tells nobody outside a private channel, so offering the whole workspace there would offer
 *   names it silently drops; there is no channel member list to ask (`API.md` §4).
 *
 * Read from the query cache as the composer renders, which is every keystroke: what arrives while
 * somebody types is offered on the next letter.
 */
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, Message, MessagePage, User, WorkspaceMember } from '@purlay/types';
import { families, keys } from '../../data/keys';
import { useChannels, useMembers } from '../../data/queries';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { offerable } from './mention-suggest';

type Pages = InfiniteData<MessagePage>;

/** Every message of the channel the cache holds: its feed, and any of its threads that are open. */
const loadedMessages = (client: QueryClient, channelId: string): readonly Message[] => {
  const feed = client.getQueryData<Pages>(keys.messages(channelId))?.pages ?? [];
  const threads = client
    .getQueriesData<Pages>({ queryKey: families.thread })
    .flatMap(([, data]) => data?.pages ?? []);
  return [...feed, ...threads]
    .flatMap((page) => page.data)
    .filter((message) => message.channelId === channelId);
};

/** The pure half, so a test can hold it without a provider tree. */
export const candidatesFor = (
  channel: Channel | undefined,
  members: readonly WorkspaceMember[],
  loaded: readonly Message[],
  selfId: string,
): readonly User[] => {
  if (channel === undefined) return [];
  const people = members.map((member) => member.user);
  if (channel.type === 'public') return offerable(people, selfId);
  if (channel.type === 'direct_message')
    return channel.peer === null ? [] : offerable([channel.peer], selfId);
  const seen = new Set<string>();
  for (const message of loaded) {
    seen.add(message.sender.id);
    for (const id of message.mentions) seen.add(id);
  }
  return offerable(
    people.filter((person) => seen.has(person.id)),
    selfId,
  );
};

export const useMentionCandidates = (channelId: string): readonly User[] => {
  const { workspace } = useWorkspace();
  const session = useSession();
  const client = useQueryClient();
  const members = useMembers(workspace.id);
  const channels = useChannels(workspace.id);
  const channel = channels.data?.find((each) => each.id === channelId);
  return candidatesFor(
    channel,
    members.data ?? [],
    channel?.type === 'private' ? loadedMessages(client, channelId) : [],
    session.user.id,
  );
};
