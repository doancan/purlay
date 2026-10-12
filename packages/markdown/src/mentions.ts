/**
 * What an `@username` looks like (D-12, D-99 §3), for both sides: the server, which resolves it to a
 * person, and the client, which highlights the ones the server resolved. One pattern, so the shape a
 * notification is sent for and the shape that is drawn as one cannot drift — the client's own copy
 * disagreed on any letter outside ASCII.
 *
 * A name has GitHub's shape — letters and digits, single hyphens inside, at most 39 — and is not
 * preceded by a letter, digit, underscore, `@` or backtick (`a@b.c` is an address, `@@name` is not a
 * mention of `name`, and a name glued to the end of a code span is addressed to nobody), nor followed
 * by a letter, digit or underscore. Where code is, and which names are refused, is the caller's.
 */

/**
 * The hyphen is allowed only when an alphanumeric follows it, so the pattern has no nested
 * quantifier and cannot backtrack exponentially over a sixteen-thousand-character body.
 */
const MENTION =
  /(?<![\p{L}\p{N}_@`])@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![\p{L}\p{N}_])/gu;

/** Where a name is, in UTF-16 code units of the text it was found in, and only that text. */
export interface MentionSpan {
  /** Offset of the `@`. */
  readonly start: number;
  /** Offset just past the name. */
  readonly end: number;
  /** The name as written, without the `@`. */
  readonly name: string;
}

/** Every mention-shaped name in a text, in order. `matchAll` copies the pattern, so no state is shared between calls. */
export const mentionsIn = (text: string): MentionSpan[] =>
  [...text.matchAll(MENTION)].map((match) => {
    const [raw] = match;
    // The pattern's one group is the name, which is everything after the `@`.
    return { start: match.index, end: match.index + raw.length, name: raw.slice(1) };
  });

/**
 * The names that would address everybody, which this product does not have (D-12): refused by the
 * server and, first and in words, by the composer. Lower case: matching is case-insensitive.
 */
export const BROADCAST_NAMES: ReadonlySet<string> = new Set(['here', 'channel', 'everyone']);
