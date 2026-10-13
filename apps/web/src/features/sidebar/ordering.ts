/**
 * What the sidebar lists, and in what order — as functions of the channel list, so the
 * rules are testable without a render.
 *
 * Channels and people are two lists drawn from one answer (`GET …/channels`): a channel
 * the person has *joined* (`state !== null`) is listed, one they could merely join is
 * not (that is Browse's), and a direct message is a person, not a channel — it goes
 * under People, named by who is on the other end (D-6).
 *
 * **Order is activity, then name.** Newest message first, because that is where the
 * conversation is; a channel nobody has written in sorts after every one somebody has,
 * and ties — most often two silent channels — fall back to the name, so the list never
 * shuffles between renders for want of a rule.
 */
import type { Channel, User, WorkspaceMember } from '@purlay/types';

const byActivity = (a: Channel, b: Channel): number => {
  const left = a.lastMessageAt ?? '';
  const right = b.lastMessageAt ?? '';
  if (left !== right) return left < right ? 1 : -1;
  return (a.name ?? '').localeCompare(b.name ?? '');
};

const joined = (channels: readonly Channel[]): Channel[] =>
  channels.filter((c) => c.state !== null);

/** Channels the person is in, not DMs, most recently active first. */
export const joinedChannels = (channels: readonly Channel[]): Channel[] =>
  joined(channels)
    .filter((c) => c.type !== 'direct_message')
    .sort(byActivity);

/** Public channels the person could join, by name. */
export const joinableChannels = (channels: readonly Channel[]): Channel[] =>
  channels
    .filter((c) => c.state === null && c.type === 'public')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

/** Group conversations the person is in (D-127): three people or more, most recently active first. */
export const groups = (channels: readonly Channel[]): Channel[] =>
  joined(channels)
    .filter((c) => c.type === 'direct_message' && c.peers.length >= 2)
    .sort(byActivity);

/** One line of the People list: somebody, and the conversation with them if there is one. */
export interface Person {
  readonly user: User;
  readonly direct: Channel | null;
}

/**
 * Every member of the workspace, once — with their direct message when one exists — and
 * any direct message whose other person is no longer in the member list (they left; the
 * conversation did not). Conversations first, by activity; then the people nobody has
 * written to, by name. The person themselves is a member like any other: a note to self
 * is a direct message with yourself (`PRD.md` §4.3).
 */
export const people = (
  members: readonly WorkspaceMember[],
  channels: readonly Channel[],
): Person[] => {
  const directs = joined(channels).filter((c) => c.type === 'direct_message' && c.peer !== null);
  const byPeer = new Map(directs.map((c) => [c.peer?.id ?? '', c]));
  const seen = new Set<string>();
  const entries: Person[] = [];
  for (const { user } of members) {
    seen.add(user.id);
    entries.push({ user, direct: byPeer.get(user.id) ?? null });
  }
  for (const channel of directs) {
    if (channel.peer !== null && !seen.has(channel.peer.id)) {
      entries.push({ user: channel.peer, direct: channel });
    }
  }
  return entries.sort((a, b) => {
    if (a.direct !== null && b.direct !== null) return byActivity(a.direct, b.direct);
    if (a.direct !== null) return -1;
    if (b.direct !== null) return 1;
    return a.user.displayName.localeCompare(b.user.displayName);
  });
};

/** The largest count the sidebar writes out; past it, or with another page to load, it says so. */
export const QUESTION_COUNT_CAP = 99;

/**
 * The open-questions count as it is shown: how many roots are loaded, or the cap when
 * there are more than that or another page exists. An exact figure would need a count
 * endpoint nobody has asked for; "99+" is true, and a team with ninety-nine unfinished
 * questions has a bigger problem than this number's precision.
 */
export const shownQuestionCount = (
  loaded: number,
  more: boolean,
): { count: number; over: boolean } =>
  more || loaded > QUESTION_COUNT_CAP
    ? { count: QUESTION_COUNT_CAP, over: true }
    : { count: loaded, over: false };
