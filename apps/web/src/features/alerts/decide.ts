/**
 * When an open tab in the background interrupts its person (D-148), as rules with no browser in
 * them.
 *
 * **What needs them is not decided here.** It is the mention badge: each conversation's
 * `unreadMentionCount`, which the server counts from `NEEDS_YOU` (D-99, D-107) and tells every
 * device over the socket. A badge that went up is a new thing that needs the person — a mention, a
 * direct message, an answer in a thread they are in — and their own messages never move it. A
 * second reading of a message here would be a second definition of "needs you" (D-106, #491).
 */
import { NEEDS_YOU, type Channel, type Notification } from '@purlay/types';

/** Each conversation's mention badge, by its id. */
export type Waiting = ReadonlyMap<string, number>;

export const waitingOf = (channels: readonly Pick<Channel, 'id' | 'state'>[]): Waiting =>
  new Map(channels.map((channel) => [channel.id, channel.state?.unreadMentionCount ?? 0]));

/** The conversations whose badge went up: something new needs the person there. */
export const risen = (before: Waiting, after: Waiting): string[] =>
  [...after].filter(([id, count]) => count > (before.get(id) ?? 0)).map(([id]) => id);

/** The conversations that had something and have nothing now: read here or elsewhere, or gone. */
export const settled = (before: Waiting, after: Waiting): string[] =>
  [...before].filter(([id, count]) => count > 0 && (after.get(id) ?? 0) === 0).map(([id]) => id);

/** The person's side of the moment. */
export interface Moment {
  /** They turned notifications on for this device, and the browser allows them. */
  readonly on: boolean;
  /** Deep Work: nothing interrupts (D-15, D-108). */
  readonly quiet: boolean;
  /** The page is not in front of them. */
  readonly away: boolean;
}

export type Plan =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly channelId: string }
  | { readonly kind: 'many'; readonly count: number };

/**
 * One notice for one conversation; one for all of them when several rose at once — a reconnect that
 * read the list again, a busy minute — so the corner of the screen never fills.
 */
export const planOf = (rose: readonly string[], { on, quiet, away }: Moment): Plan => {
  if (!on || quiet || !away || rose.length === 0) return { kind: 'none' };
  const [only] = rose;
  return rose.length === 1 && only !== undefined
    ? { kind: 'one', channelId: only }
    : { kind: 'many', count: rose.length };
};

/** Away: the page is hidden, or shown and not focused — another window is where they are. */
export const isAway = (page: Pick<Document, 'visibilityState' | 'hasFocus'>): boolean =>
  page.visibilityState === 'hidden' || !page.hasFocus();

/** One tag a conversation: its next notice replaces its last instead of joining it. */
export const tagOf = (channelId: string): string => `purlay:c:${channelId}`;

/** One tag a workspace for "several need you". */
export const summaryTag = (workspaceId: string): string => `purlay:w:${workspaceId}`;

const needsYou = (type: Notification['type']): boolean =>
  NEEDS_YOU.some((reason) => reason === type);

/**
 * What a notice for a conversation says: its newest unread notification that needs the person, from
 * somebody else. `null` when the page read does not have it yet — the notice then says only where.
 */
export const newestFor = (
  page: readonly Notification[],
  channelId: string,
  me: string,
): Notification | null =>
  page.find(
    (n) =>
      n.channelId === channelId &&
      n.readAt === null &&
      needsYou(n.type) &&
      n.message.sender?.id !== me,
  ) ?? null;

/** The number on the icon: what the title counts, and nothing in Deep Work, as the badges. */
export const badgeOf = (waiting: number, quiet: boolean): number => (quiet ? 0 : waiting);
