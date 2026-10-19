/**
 * One busy thread is one row (D-162). The replies to one thread told on one day — the person's own
 * day — are gathered into the row of the newest, where it already sat in the newest-first list, so
 * nothing above it moves. Only `thread_reply` is gathered: a mention, a direct message or a
 * resolution is said on its own, even inside a thread, because each one is about the person.
 */
import type { Notification } from '@purlay/types';
import { authorOf } from '../messages/author';

export interface InboxRow {
  /** The newest member's id: stable while older ones join it from the next page. */
  readonly key: string;
  readonly newest: Notification;
  /** Newest first; one, for anything that is not gathered. */
  readonly members: readonly Notification[];
}

const dayOf = (at: string): string => {
  const date = new Date(at);
  return `${String(date.getFullYear())}-${String(date.getMonth())}-${String(date.getDate())}`;
};

/** The list as rows, in the order it came: newest first. */
export const groupInbox = (list: readonly Notification[]): InboxRow[] => {
  const rows: { key: string; newest: Notification; members: Notification[] }[] = [];
  const open = new Map<string, Notification[]>();
  for (const notification of list) {
    const { thread } = notification;
    if (notification.type !== 'thread_reply' || thread === null) {
      rows.push({ key: notification.id, newest: notification, members: [notification] });
      continue;
    }
    const gathered = `${thread.rootId} ${dayOf(notification.createdAt)}`;
    const members = open.get(gathered);
    if (members === undefined) {
      const fresh = [notification];
      open.set(gathered, fresh);
      rows.push({ key: notification.id, newest: notification, members: fresh });
    } else {
      members.push(notification);
    }
  }
  return rows;
};

/** Who replied, newest first and each once: the first two by name, and how many more. */
export const repliersOf = (
  members: readonly Notification[],
  erased: string,
): { readonly shown: readonly string[]; readonly more: number } => {
  const people = new Map<string, string>();
  for (const { message } of members) {
    const key = message.sender?.id ?? 'github';
    if (!people.has(key)) people.set(key, authorOf(message, erased).displayName);
  }
  const names = [...people.values()];
  return { shown: names.slice(0, 2), more: Math.max(0, names.length - 2) };
};
