/**
 * Where a result's words were found (#664). A row shows a message's excerpt (#651), which a long
 * message cuts off after two lines — often before the words that found it. So the excerpt starts a
 * little before the first match, at a word, said with an ellipsis, and the match is marked.
 *
 * Matched as the server matches: the words as typed, ignoring case, anywhere (D-105 §1). The server
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

export const markedExcerpt = (text: string, words: string): MarkedExcerpt | null => {
  const wanted = words.trim();
  if (wanted === '') return null;
  // On the text itself, not a lower-cased copy: a letter whose lower case is longer (İ) would move
  // every index after it.
  const found = new RegExp(wanted.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'iu').exec(text);
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
