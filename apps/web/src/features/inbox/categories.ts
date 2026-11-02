/**
 * The inbox's categories (D-208): the reasons a person is told, gathered into the four a person
 * sorts them by — everything, being named, being written to directly, and threads.
 *
 * A category is a server query, never a filter over pages already loaded (D-153): it is sent as the
 * `types` the API already takes (D-106 #787), so "Mentions" shows every mention and not the
 * mentions that happened to be in the first fifty rows. A channel's every message (D-107) has no
 * category of its own — it is the weakest reason, and a person who asked for it reads it in All.
 */
import type { NotificationType, NotificationTypesFilter } from '@purlay/types';

export const INBOX_CATEGORIES = ['all', 'mentions', 'direct', 'threads'] as const;
export type InboxCategory = (typeof INBOX_CATEGORIES)[number];

const TYPES = {
  mentions: ['mention'],
  direct: ['direct_message'],
  // A reply and the resolution of a question both happen in a thread the person is part of (D-29).
  threads: ['thread_reply', 'thread_resolved'],
} as const satisfies Record<Exclude<InboxCategory, 'all'>, readonly NotificationType[]>;

/** The `types` the server is asked for; none for All, which is every type. */
export const typesOf = (category: InboxCategory): NotificationTypesFilter | undefined =>
  category === 'all' ? undefined : TYPES[category].join(',');

/** `?category=` on the inbox's address, so "See all" lands on the same view, and Back keeps it. */
const CATEGORY_PARAM = 'category';

/** The category an address names; anything else — absent, misspelt, old — is All. */
export const categoryIn = (search: string): InboxCategory => {
  const value = new URLSearchParams(search).get(CATEGORY_PARAM);
  return INBOX_CATEGORIES.find((category) => category === value) ?? 'all';
};

/** The query for a category's inbox, without its `?`: none for All, the bare address it always was. */
export const inboxSearch = (category: InboxCategory): string | undefined =>
  category === 'all' ? undefined : `${CATEGORY_PARAM}=${category}`;
