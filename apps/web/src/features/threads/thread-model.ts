/**
 * What a thread shows, as data: the replies the server has, the ones still on their way,
 * and who is grouped under whom — the feed's rules (`feed-model.ts`), for one root's replies.
 *
 * Pure for the same reason: every rule that can be a rule is a test of a function. The
 * differences from the feed are the ones `UX.md` §4.2 names: replies run oldest first
 * down to the composer, there are no day dividers and no unread marker (a thread is read
 * from its top, and the position that matters is the channel's), and a pending reply is the
 * person's own send whose `parentId` is this root.
 *
 * **A pending reply does not move when its echo arrives** — same id, same order — and one
 * whose id the server's list already holds is dropped here rather than shown twice.
 */
import type { FailureCode } from '../../data/failure';
import type { Message, User } from '@purlay/types';
import type { PendingMessage } from '../../realtime/engine';
import { GROUP_WINDOW_MS } from '../channel/feed-model';
import { sameAuthor } from '../messages/author';

export interface ReplyItem {
  readonly key: string;
  readonly message: Message;
  readonly delivery: 'sent' | 'sending' | 'failed';
  readonly failure: FailureCode | null;
  readonly grouped: boolean;
}

export interface ReplyInput {
  /** The server's replies, oldest first. */
  readonly replies: readonly Message[];
  /** This person's sends not yet confirmed, already narrowed to this root. */
  readonly pending: readonly PendingMessage[];
  readonly me: User;
}

const asReply = (pending: PendingMessage, me: User): Message => ({
  id: pending.id,
  channelId: pending.channelId,
  sender: me,
  githubEvent: null,
  content: pending.content,
  editedAt: null,
  deletedAt: null,
  createdAt: pending.createdAt,
  parentId: pending.parentId,
  // A reply has no thread of its own (I-1).
  thread: null,
  reactions: [],
  mentions: [],
  attachments: [...pending.attachments],
});

interface Entry {
  readonly message: Message;
  readonly delivery: ReplyItem['delivery'];
  readonly failure: FailureCode | null;
}

const byId = (a: Entry, b: Entry): number =>
  a.message.id < b.message.id ? -1 : a.message.id > b.message.id ? 1 : 0;

export const buildReplies = ({ replies, pending, me }: ReplyInput): ReplyItem[] => {
  const known = new Set(replies.map((r) => r.id));
  const confirmed: Entry[] = replies.map((message) => ({
    message,
    delivery: 'sent',
    failure: null,
  }));
  const waiting: Entry[] = pending
    .filter((p) => !known.has(p.id))
    .map((p) => ({
      message: asReply(p, me),
      delivery: p.delivery === 'failed' ? 'failed' : 'sending',
      failure: p.reason,
    }));

  const items: ReplyItem[] = [];
  let previous: Message | null = null;
  for (const entry of [...confirmed, ...waiting].sort(byId)) {
    const { message } = entry;
    const gap =
      previous === null
        ? Number.NaN
        : Date.parse(message.createdAt) - Date.parse(previous.createdAt);
    const grouped =
      previous !== null && sameAuthor(previous, message) && gap >= 0 && gap < GROUP_WINDOW_MS;
    items.push({ key: message.id, ...entry, grouped });
    previous = message;
  }
  return items;
};
