/**
 * What the push sender needs to know about a write without naming what the write was (D-250): who it told, why,
 * and where in the application they should land. The core defines it, and chat — whose messages and notifications
 * they are — implements it where the application is put together. With chat absent nothing tells anybody, and
 * `noPushNotices` says so.
 */
import type { Executor } from '@purlay/db';

/** One notification still to be pushed: the person told, why, and the channel it happened in. */
interface PushNotice {
  readonly userId: string;
  /** The notification's reason, as the person's inbox names it. */
  readonly type: string;
  readonly channelId: string;
  readonly workspaceId: string;
  /** The channel's name; none for a direct message or a group. */
  readonly channelName: string | null;
  /** A group's people besides the one told, by name; none outside a group. */
  readonly groupNames: string | null;
  readonly authorName: string;
  /** The sender of the root of the thread a reply belongs to; none for anything else. */
  readonly rootSenderId: string | null;
}

export interface PushNotices {
  /**
   * The notifications of `messageId` that are still unread, not held back by Deep Work, of a reason that needs the
   * person, on a message not deleted, for these people.
   */
  of(executor: Executor, messageId: string, userIds: readonly string[]): Promise<PushNotice[]>;
}

/** The notifications of a process that runs no chat: none. */
export const noPushNotices: PushNotices = { of: () => Promise.resolve([]) };
