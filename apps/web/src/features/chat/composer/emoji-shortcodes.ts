/**
 * The `:name` autocomplete's half that knows no DOM (`UX.md` §5): where a shortcode is being typed, which
 * emoji it may be, and what choosing one writes into the box.
 *
 * **It writes the emoji itself, never the name.** What is stored and sent is the character, so every
 * reader, search and export sees the same thing whatever the catalogue of names does later.
 *
 * A query needs two characters, so the faces typed as text of D-253 (`:D`, `:P`, `:/`) are never a query.
 * The names themselves are in `emoji-names.ts`, which loads when the first colon is typed: the table is
 * not what every open channel pays for (the chat chunk is held to a byte budget).
 *
 * Every scan is linear and bounded: the box holds up to sixteen thousand characters, and nothing here
 * looks further back than a name could be.
 */
import { insideFence } from './composer-text';

/** Fewer than this is punctuation (`:D`, `a :) b`), not a name. */
export const QUERY_MIN = 2;

/** Longer than any name in the table. */
const QUERY_MAX = 32;

/** What may not stand before the colon: `12:30`, `Note:tada` and `host:80` are not shortcodes. */
const GLUED = /[\p{L}\p{N}_:/]/u;

/** What a name is written with. */
const NAME_LETTER = /[\p{L}\p{N}_+-]/u;

export interface ShortcodeEntry {
  readonly name: string;
  readonly emoji: string;
}

/** A shortcode being typed: the colon at `start`, and the letters after it up to the caret. */
export interface ShortcodeQuery {
  readonly start: number;
  readonly query: string;
}

/** Whether the line before `at` holds an odd number of backticks: the colon is inside inline code. */
const insideInlineCode = (text: string, at: number): boolean =>
  (text.slice(text.lastIndexOf('\n', at - 1) + 1, at).split('`').length - 1) % 2 === 1;

/**
 * The shortcode the caret is at the end of, or null: a colon, then at least two name characters and
 * none of them a space, standing alone (not after a letter, a digit, another colon or a slash), outside
 * code. A caret in the middle of a name is moving through it, not writing it.
 */
export const shortcodeQuery = (text: string, caret: number): ShortcodeQuery | null => {
  const from = Math.max(0, caret - QUERY_MAX - 1);
  let at = caret - 1;
  while (at >= from) {
    const character = text.charAt(at);
    if (character === ':') break;
    if (!NAME_LETTER.test(character)) return null;
    at -= 1;
  }
  if (at < from || text.charAt(at) !== ':') return null;
  const query = text.slice(at + 1, caret);
  if (query.length < QUERY_MIN) return null;
  if (NAME_LETTER.test(text.charAt(caret))) return null;
  if (at > 0 && GLUED.test(text.charAt(at - 1))) return null;
  if (insideInlineCode(text, at) || insideFence(text.slice(0, at))) return null;
  return { start: at, query };
};
