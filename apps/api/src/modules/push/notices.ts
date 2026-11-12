/**
 * What the push sender needs to know about a write without naming what the write was (D-250): who it told, why,
 * and where in the application they should land. The core defines it, and chat — whose messages and notifications
 * they are — implements it where the application is put together. With chat absent nothing tells anybody, and
 * `noPushNotices` says so.
 */
import type { Executor } from '@purlay/db';
import type { PushLocale } from '@purlay/types';

/** Core admission port: the source owner captures its recipients in the same transaction as its notice. */
export { enqueuePush } from '../../platform/push-work';

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
  /** The thread the notification opens; null for a channel-level notice. */
  readonly threadId: string | null;
}

export interface PushNotices {
  /**
   * The notifications of `messageId` that are still unread, not held back by Deep Work, of a reason that needs the
   * person, on a message not deleted, for these people.
   */
  of(
    executor: Executor,
    messageId: string,
    userIds: readonly string[],
    notificationId?: string,
  ): Promise<PushNotice[]>;
  /** Current source visibility and unread state, asked again when a queued device may be sent to. */
  canDeliver(
    executor: Executor,
    messageId: string,
    userId: string,
    notificationId?: string,
  ): Promise<boolean>;
}

/** The notifications of a process that runs no chat: none. */
export const noPushNotices: PushNotices = {
  of: () => Promise.resolve([]),
  canDeliver: () => Promise.resolve(false),
};

/** What a push says of a module's notice in the core's inbox, and where in the workspace it lands (`path`, without a slash). */
interface NoticeSaying {
  readonly body: string;
  readonly path: string;
}

/**
 * The words of a notice's kind, in the person's language, with the name of who acted: the module that declares the kind
 * supplies them, since the core knows no module's words (D-286 §9). It answers `undefined` for a kind it does not word. They
 * say who and why, never what the notice carries.
 */
export type NoticeWords = (
  kind: string,
  locale: PushLocale,
  actor: string,
) => NoticeSaying | undefined;

/** The words of a process that runs no module with a notice a device is told of. */
export const noNoticeWords: NoticeWords = () => undefined;
