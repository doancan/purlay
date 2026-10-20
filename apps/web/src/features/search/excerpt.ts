/**
 * Where a result's words were found (#664). A row shows a message's excerpt (#651), which a long
 * message cuts off after two lines — often before the words that found it. So the excerpt starts a
 * little before the first match, at a word, said with an ellipsis, and every match in it is marked —
 * the first one where it starts, the rest by `marksIn`, so a word said three times is seen three times.
 *
 * Matched as the server matches: the words as typed, ignoring case — I ı İ i as one letter — anywhere
 * (D-105 §1). The server
 * matched the message as typed and this marks the excerpt a reader sees, so words that were found in
 * the markdown and not in the words (`` `api` ``) mark nothing, and the excerpt is shown from its start.
 */

/** How much of what comes before a match is kept, so it is read in its place. */
const LEAD = 40;

export interface MarkedExcerpt {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/**
 * The words as the server matches them. On the text itself, not a lower-cased copy: a letter whose
 * lower case is longer (İ) would move every index after it. Each of I ı İ i stands for all four, as
 * the server folds them (#701, #704); every other letter's case is the `u` flag's.
 */
const patternOf = (wanted: string): string =>
  wanted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/[iıİI]/gu, '[iıİI]');

export interface Part {
  readonly text: string;
  readonly marked: boolean;
}

/** A stretch of text cut where the words are, each piece marked or not; the whole text, unmarked, when they are not in it. */
export const marksIn = (text: string, words: string): readonly Part[] => {
  const wanted = words.trim();
  if (wanted === '' || text === '') return text === '' ? [] : [{ text, marked: false }];
  const parts: Part[] = [];
  let from = 0;
  for (const found of text.matchAll(new RegExp(patternOf(wanted), 'giu'))) {
    if (found.index > from) parts.push({ text: text.slice(from, found.index), marked: false });
    parts.push({ text: found[0], marked: true });
    from = found.index + found[0].length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), marked: false });
  return parts;
};

export const markedExcerpt = (text: string, words: string): MarkedExcerpt | null => {
  const wanted = words.trim();
  if (wanted === '') return null;
  const found = new RegExp(patternOf(wanted), 'iu').exec(text);
  if (found === null) return null;
  const at = found.index;
  const match = found[0];
  const after = text.slice(at + match.length);
  if (at <= LEAD) return { before: text.slice(0, at), match, after };
  // Start at the first word that begins inside the lead, never in the middle of one.
  const from = text.indexOf(' ', at - LEAD);
  const start = from === -1 || from >= at ? at : from + 1;
  return { before: `…${text.slice(start, at)}`, match, after };
};
