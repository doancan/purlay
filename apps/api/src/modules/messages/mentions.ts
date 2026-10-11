/**
 * `@username`, found in a message body (D-12, D-99 §3).
 *
 * **Parsed once, at write time**, so a notification fan-out never re-reads a body and
 * a client never has to. The rules are the ones D-99 states and no more:
 *
 * - a mention is `@name` in the shape `mentionsIn` (`@purlay/markdown`) reads, which the
 *   client highlights with too;
 * - it is not inside inline or fenced code, where somebody is quoting;
 * - `@here`, `@channel` and `@everyone` are **refused**, not ignored: the broadcast
 *   mentions the product does not have (D-12).
 *
 * Everything here is pure and linear in the length of the text: the longest body is
 * sixteen thousand characters and arrives from anyone with a session, so nothing
 * below backtracks over its input more than a bounded number of steps.
 */

import { mentionsIn } from '@purlay/markdown';

/** The names the parser refuses outright. Lower case: matching is case-insensitive. */
const BROADCAST: ReadonlySet<string> = new Set(['here', 'channel', 'everyone']);

/** More than this many distinct names in one message are ignored: a bound on what one write may fan out to. */
export const MENTIONS_PER_MESSAGE_MAX = 50;

interface Run {
  /** Where the run of backticks starts. */
  readonly at: number;
  readonly length: number;
}

/**
 * The text with every code span and fenced block replaced by a single backtick.
 *
 * A backtick rather than nothing, so a mention that follows a span is still "preceded
 * by a backtick" and is not one. A run of one or two backticks opens a span that ends
 * at the next run of the same length, and is plain text when there is none; a run of
 * three or more opens a fence that ends at the next run of the same length, or at the
 * end of the text when there is none, which is how a fence somebody has not closed
 * yet reads. The matching is one pass over the runs, not a search from each.
 */
const withoutCode = (text: string): string => {
  const runs: Run[] = [];
  for (const match of text.matchAll(/`+/g)) {
    runs.push({ at: match.index, length: match[0].length });
  }
  if (runs.length === 0) return text;

  // For each run, the next run of exactly its length — built backwards in one pass.
  const next: (number | undefined)[] = Array.from({ length: runs.length });
  const seen = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run === undefined) continue;
    next[index] = seen.get(run.length);
    seen.set(run.length, index);
  }

  let out = '';
  let cursor = 0;
  let index = 0;
  while (index < runs.length) {
    const run = runs[index];
    if (run === undefined) break;
    const closer = next[index];
    const closing = closer === undefined ? undefined : runs[closer];
    if (closing === undefined && run.length < 3) {
      index += 1;
      continue;
    }
    out += `${text.slice(cursor, run.at)}\``;
    if (closing === undefined || closer === undefined) {
      cursor = text.length;
      break;
    }
    cursor = closing.at + closing.length;
    index = closer + 1;
  }
  return out + text.slice(cursor);
};

export interface ParsedMentions {
  /** Distinct, in order of first appearance, as written. */
  readonly names: readonly string[];
  /** The refused broadcast names that appeared, lower case. Empty when the message is acceptable. */
  readonly broadcast: readonly string[];
}

/** Every mention-shaped name in a body, outside code, and which of them are refused. */
export const parseMentions = (content: string): ParsedMentions => {
  const names: string[] = [];
  const broadcast: string[] = [];
  const known = new Set<string>();
  for (const { name } of mentionsIn(withoutCode(content))) {
    const key = name.toLowerCase();
    if (BROADCAST.has(key)) {
      if (!broadcast.includes(key)) broadcast.push(key);
    } else if (!known.has(key) && known.size < MENTIONS_PER_MESSAGE_MAX) {
      known.add(key);
      names.push(name);
    }
  }
  return { names, broadcast };
};
