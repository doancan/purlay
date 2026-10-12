/**
 * Messages that were sent and not yet known to have arrived, kept across a reload.
 *
 * "A send is never silently dropped" (`ARCHITECTURE.md` §5.3) was true of a page that stayed
 * open and false of one that did not: the in-flight rows live in memory, and the composer
 * clears its draft the moment a message is sent, so a tab closed, crashed or reloaded in the
 * seconds a send was waiting — which is exactly when the network is bad — lost what the
 * person had written, with nobody told. These are written to `localStorage` as they are
 * sent and read back on boot as **failed**, with the Retry the row already has: the same
 * id, so a message that did reach the server comes back as itself and is not duplicated (D-8).
 *
 * **Per person.** The key carries the user id, so a different person signing in on the same
 * browser never sees, and never re-sends, what someone else wrote. Signing out removes them
 * all (`browser-storage.ts`).
 *
 * **Bounded.** Fifty messages and about two hundred thousand characters, newest kept: the
 * quota is shared with everything else the page stores, and a store that fills it makes
 * the next draft fail to save instead. Every access is guarded — storage can be missing,
 * full or refuse — and a failure to remember is a message that is not remembered, never a
 * send that does not work.
 */
import { Value } from '@sinclair/typebox/value';
import { Attachment, isMessageIdShape } from '@purlay/types';
import { noteStorageFailure, type ClientStorage } from '../data/browser-storage';

export interface StoredMessage {
  readonly id: string;
  readonly channelId: string;
  readonly parentId: string | null;
  readonly content: string;
  readonly createdAt: string;
  /** What it carries; absent in what an older page kept, which carried nothing. */
  readonly attachments?: readonly Attachment[];
}

export const MAX_STORED = 50;
export const MAX_STORED_CHARS = 200_000;

export const pendingKey = (userId: string): string => `purlay.pending.${userId}`;

const isStored = (value: unknown): value is StoredMessage =>
  typeof value === 'object' &&
  value !== null &&
  'id' in value &&
  typeof value.id === 'string' &&
  isMessageIdShape(value.id) &&
  'channelId' in value &&
  typeof value.channelId === 'string' &&
  'content' in value &&
  typeof value.content === 'string' &&
  // No words is a message only beside an attachment (D-109 §7).
  (value.content !== '' ||
    ('attachments' in value && Array.isArray(value.attachments) && value.attachments.length > 0)) &&
  (!('attachments' in value) ||
    (Array.isArray(value.attachments) &&
      value.attachments.every((a: unknown) => Value.Check(Attachment, a)))) &&
  'createdAt' in value &&
  typeof value.createdAt === 'string' &&
  'parentId' in value &&
  (value.parentId === null || typeof value.parentId === 'string');

/** What was kept for this person; anything that is not what this wrote is ignored, not trusted. */
export const loadStored = (storage: ClientStorage | null, userId: string): StoredMessage[] => {
  try {
    const raw = storage?.getItem(pendingKey(userId));
    if (raw === null || raw === undefined) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStored).slice(-MAX_STORED);
  } catch {
    noteStorageFailure('pending-read');
    return [];
  }
};

/** The newest messages that fit; an empty list removes the entry, so a person with nothing in flight leaves nothing behind. */
export const saveStored = (
  storage: ClientStorage | null,
  userId: string,
  messages: readonly StoredMessage[],
): void => {
  try {
    const kept: StoredMessage[] = [];
    let chars = 0;
    for (const message of [...messages].reverse()) {
      chars += message.content.length;
      if (kept.length >= MAX_STORED || chars > MAX_STORED_CHARS) break;
      kept.unshift(message);
    }
    if (kept.length === 0) storage?.removeItem(pendingKey(userId));
    else storage?.setItem(pendingKey(userId), JSON.stringify(kept));
  } catch {
    // Not remembered (full, refused, missing); the send itself is unaffected.
    noteStorageFailure('pending-write');
  }
};
