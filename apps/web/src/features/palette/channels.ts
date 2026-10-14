/**
 * The channels a person is in, as a person sees them: in the order the sidebar lists
 * them, under the names the sidebar gives them.
 *
 * One definition, because the palette lists them, `Alt+↑/↓` walks them, and a
 * sidebar that ordered them differently from the key that steps through them would
 * make "next unread" mean something nobody can see.
 */
import { nameOf } from '../messages/author';
import type { Channel } from '@purlay/types';
import { joinedChannels, starredChannels } from '../sidebar/ordering';

/** Only channels the person has joined: one they can merely see has nothing to read. */
const joined = (channels: readonly Channel[]): Channel[] =>
  channels.filter((c) => c.state !== null);

const byActivity = (a: Channel, b: Channel): number => {
  const left = a.lastMessageAt ?? '';
  const right = b.lastMessageAt ?? '';
  if (left !== right) return left < right ? 1 : -1;
  return (a.name ?? '').localeCompare(b.name ?? '');
};

/**
 * The starred channels by name, the other channels most recently active first, then direct
 * messages — the sidebar's own lists, read from where it reads them (D-132).
 */
export const inSidebarOrder = (channels: readonly Channel[]): Channel[] => [
  ...starredChannels(channels),
  ...joinedChannels(channels),
  ...joined(channels)
    .filter((c) => c.type === 'direct_message')
    .sort(byActivity),
];

/**
 * The next channel with something unread after `currentId`, or the previous one, wrapping
 * round the end; null when nothing else is unread. The channel being read does not count
 * as "another": stepping from the only unread channel goes nowhere.
 */
export const stepUnread = (
  ordered: readonly Channel[],
  currentId: string | null,
  direction: 1 | -1,
): Channel | null => {
  const count = ordered.length;
  const here = ordered.findIndex((c) => c.id === currentId);
  // Not in the list (a view, a channel not joined): start just outside it in the direction of travel.
  const origin = here === -1 ? (direction === 1 ? -1 : count) : here;
  for (let step = 1; step <= count; step++) {
    const index = (((origin + direction * step) % count) + count) % count;
    const candidate = ordered[index];
    if (
      candidate !== undefined &&
      candidate.id !== currentId &&
      (candidate.state?.unreadCount ?? 0) > 0
    ) {
      return candidate;
    }
  }
  return null;
};

/** The name a person knows a channel by: its own, or — in a direct message — the other person's. */
export const displayName = (
  channel: Channel,
  me: string,
  youLabel: string,
  erased: string,
): string => {
  if (channel.type !== 'direct_message') return channel.name ?? '';
  const peer = channel.peer;
  // A group, by its people (D-127).
  if (peer === null) return channel.peers.map((person) => nameOf(person, erased)).join(', ');
  return peer.id === me ? youLabel : nameOf(peer, erased);
};
