/**
 * Quote reply (D-213): a message — or the part of it the person selected — put in a composer as a
 * markdown quote, with who wrote it and a link back to it, the caret under it to answer.
 *
 * - **The quote is markdown the renderer draws**: each line behind `> `, so a quoted list or block of
 *   code stays one inside the quote.
 * - **Who wrote it is named, not mentioned**: their display name, never `@username`, so quoting
 *   somebody does not notify them (D-12) — the link back is how the reader finds the original.
 * - **Bounded**: a long message is quoted to its first `QUOTE_MAX` characters, ended at a line.
 *
 * A composer is reached by its key — a channel's, or a thread's — through `sendToComposer`, so the
 * message's menu needs no handle on whichever composer is open; a composer not mounted hears nothing.
 */
import { useEffect, useRef } from 'react';

/** The most of a message quoted: a quote is a pointer to the original, not a copy of it. */
const QUOTE_MAX = 1_000;

/** The composer a quote goes to: the channel's, or the thread of this root's. */
export const composerKey = (channelId: string, parentId: string | null): string =>
  parentId === null ? `channel:${channelId}` : `thread:${channelId}:${parentId}`;

/** The words quoted, as markdown: the quote, then the line that says whose it is and where. */
export const quoteMarkdown = (text: string, author: string, link: string | null): string => {
  const trimmed = text.trim();
  let body = trimmed;
  if (trimmed.length > QUOTE_MAX) {
    const end = trimmed.lastIndexOf('\n', QUOTE_MAX);
    body = `${trimmed.slice(0, end > 0 ? end : QUOTE_MAX)}…`;
  }
  const quoted = body
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
  const who = link === null ? author : `${author} · [message](${link})`;
  return `${quoted}\n> — ${who}\n\n`;
};

type Listener = (markdown: string) => void;
const listeners = new Map<string, Set<Listener>>();
const focusers = new Map<string, () => void>();

/** Puts markdown in the composer with this key, if one is open; says whether one took it. */
export const sendToComposer = (key: string, markdown: string): boolean => {
  const heard = listeners.get(key);
  if (heard === undefined || heard.size === 0) return false;
  for (const listener of heard) listener(markdown);
  return true;
};

/**
 * Puts focus in the composer with this key. Called once the menu that sent the quote has closed:
 * while it is open, or closing, it holds focus itself.
 */
export const focusComposer = (key: string): void => {
  focusers.get(key)?.();
};

/** What a composer listens with: the newest handler, under its key, for as long as it is mounted. */
export const useComposerInbox = (key: string, onMarkdown: Listener, focus: () => void): void => {
  const latest = useRef(onMarkdown);
  const latestFocus = useRef(focus);
  useEffect(() => {
    latest.current = onMarkdown;
    latestFocus.current = focus;
  });
  useEffect(() => {
    focusers.set(key, () => {
      latestFocus.current();
    });
    return (): void => {
      focusers.delete(key);
    };
  }, [key]);
  useEffect(() => {
    const listener: Listener = (markdown) => {
      latest.current(markdown);
    };
    const set = listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(key, set);
    return (): void => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(key);
    };
  }, [key]);
};
