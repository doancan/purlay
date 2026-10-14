/**
 * Who a message is by, asked in one place (D-134 §6). A person's message has its sender; a message a
 * repository's feed posted has none, and is GitHub's. Every screen that names an author, and every
 * rule that asks "is this mine?" — the side a bubble sits on, the edit shortcut, grouping, the new
 * divider, following the bottom, typing — asks here, so an event is nobody's and never yours.
 */
import type { Message } from '@purlay/types';

export interface Author {
  /** What is written beside the message. */
  readonly displayName: string;
  /** The handle: what an avatar's tint is chosen from, and what a list names. */
  readonly username: string;
}

/** A feed's messages are GitHub's: the name GitHub calls itself, in either language. */
const GITHUB: Author = { displayName: 'GitHub', username: 'github' };

export const authorOf = (message: Pick<Message, 'sender'>): Author =>
  message.sender === null
    ? GITHUB
    : { displayName: message.sender.displayName, username: message.sender.username };

/** Whether this person wrote it: never for a message nobody wrote. */
export const isMine = (message: Pick<Message, 'sender'>, userId: string | undefined): boolean =>
  message.sender !== null && message.sender.id === userId;

/** Whether two messages are by the same person, for grouping: events stand alone. */
export const sameAuthor = (a: Pick<Message, 'sender'>, b: Pick<Message, 'sender'>): boolean =>
  a.sender !== null && b.sender !== null && a.sender.id === b.sender.id;
