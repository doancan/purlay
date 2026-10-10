/**
 * What the feed shows, as data: the messages the server has, the ones still on their way,
 * the day each begins, who is grouped under whom, and where the unread marker goes.
 *
 * Pure on purpose — no React, no clock, no DOM — so every rule of `UX.md` §3 and §6 that
 * can be a rule is a test of a function. The component only draws what this returns.
 *
 * **One list, ordered by id.** A UUIDv7 sorts by time, so the server's messages and the
 * person's own pending ones merge by comparing ids, and a pending message **does not move
 * when its echo arrives**: the id was final from the start (D-8), and a pending row whose
 * id the server's list already holds is dropped here rather than shown twice.
 */
import type { FailureCode } from '../../data/failure';
import type { Message, User } from '@purlay/types';
import type { PendingMessage } from '../../realtime/engine';

/** Same author within this long of the row above: the name is not repeated (`UX.md` §3). */
export const GROUP_WINDOW_MS = 5 * 60_000;

export type FeedItem =
  | {
      readonly kind: 'message';
      readonly key: string;
      readonly message: Message;
      readonly delivery: 'sent' | 'sending' | 'failed';
      readonly failure: FailureCode | null;
      readonly grouped: boolean;
    }
  | { readonly kind: 'day'; readonly key: string; readonly label: string }
  | { readonly kind: 'marker'; readonly key: 'marker' };

export interface FeedInput {
  /** The server's root messages, oldest first. */
  readonly messages: readonly Message[];
  /** This person's sends not yet confirmed, for this channel's feed (roots only). */
  readonly pending: readonly PendingMessage[];
  readonly me: User;
  /**
   * The read position when the channel was opened, or `undefined` when there is nothing
   * unread to mark. `null` means "never read anything": the marker then sits above the
   * oldest message, which is only true when no older page is left to load.
   */
  readonly markerAfter: string | null | undefined;
  /** A day's label, which is also its identity: two timestamps on one day label alike. */
  readonly dayLabel: (iso: string) => string;
}

/** A pending send, shaped as the message it will become. */
const asMessage = (pending: PendingMessage, me: User): Message => ({
  id: pending.id,
  channelId: pending.channelId,
  sender: me,
  content: pending.content,
  editedAt: null,
  deletedAt: null,
  createdAt: pending.createdAt,
  parentId: null,
  thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
  reactions: [],
  mentions: [],
});

interface Entry {
  readonly message: Message;
  readonly delivery: 'sent' | 'sending' | 'failed';
  readonly failure: FailureCode | null;
}

export const buildFeed = ({
  messages,
  pending,
  me,
  markerAfter,
  dayLabel,
}: FeedInput): FeedItem[] => {
  const held = new Set(messages.map((m) => m.id));
  const entries: Entry[] = [
    ...messages.map((message): Entry => ({ message, delivery: 'sent', failure: null })),
    ...pending
      .filter((p) => !held.has(p.id))
      .map((p): Entry => ({
        message: asMessage(p, me),
        // `sent` is the server's ACK having come while the echo has not: it is still on screen
        // as the person's own, and no longer waiting.
        delivery:
          p.delivery === 'failed' ? 'failed' : p.delivery === 'sending' ? 'sending' : 'sent',
        failure: p.reason,
      })),
  ].sort((a, b) => (a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0));

  // The first message by somebody else past the read position — what the marker sits above.
  const markerAt =
    markerAfter === undefined
      ? null
      : (entries.find(
          (entry) =>
            entry.delivery === 'sent' &&
            entry.message.sender.id !== me.id &&
            (markerAfter === null || entry.message.id > markerAfter),
        )?.message.id ?? null);

  const items: FeedItem[] = [];
  let lastDay: string | null = null;
  let previous: Entry | null = null;

  for (const entry of entries) {
    const { message } = entry;
    const label = dayLabel(message.createdAt);
    let startsDay = false;
    if (label !== lastDay) {
      items.push({ kind: 'day', key: `day:${label}`, label });
      lastDay = label;
      startsDay = true;
    }
    const marked = message.id === markerAt;
    if (marked) items.push({ kind: 'marker', key: 'marker' });

    const grouped =
      !startsDay &&
      !marked &&
      previous !== null &&
      previous.delivery !== 'failed' &&
      entry.delivery !== 'failed' &&
      previous.message.sender.id === message.sender.id &&
      Date.parse(message.createdAt) - Date.parse(previous.message.createdAt) < GROUP_WINDOW_MS &&
      Date.parse(message.createdAt) >= Date.parse(previous.message.createdAt);

    items.push({
      kind: 'message',
      key: message.id,
      message,
      delivery: entry.delivery,
      failure: entry.failure,
      grouped,
    });
    previous = entry;
  }
  return items;
};

/** The newest message the server has confirmed in a feed — what a read position names. */
export const newestConfirmedId = (items: readonly FeedItem[]): string | null => {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'message' && item.delivery === 'sent') return item.message.id;
  }
  return null;
};
