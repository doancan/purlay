/**
 * What the composer knows about the text it holds — pure functions, no DOM.
 *
 * Four questions, each answered once and tested alone: is the caret inside an open
 * code fence (so Enter is a newline, not a send), does the text address everybody
 * (`@here`, which the server refuses and the composer refuses first), what does a
 * long paste become, and how far over the limit is the text.
 *
 * **Every scan is linear.** The input is up to 16,000 characters typed or pasted by
 * anybody; nothing here backtracks, so no input makes the composer hang (D-33's
 * reasoning about untrusted input holds on the client too).
 */
import { BROADCAST_NAMES, parseMarkdown, proseNames } from '@purlay/markdown';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';

/** A line that opens or closes a fenced block: three or more backticks first on the line. */
const FENCE_LINE = /^`{3,}/;

/** How many lines a paste may have before it is made a code block (`UX.md` §5). */
const PASTE_FENCE_AFTER_LINES = 12;

/** The counter appears this close to the limit and not before: it is noise until it matters. */
const COUNTER_FROM_REMAINING = 500;

/**
 * Whether the caret is inside a fence that is open or being opened.
 *
 * Fence lines in the text *up to the caret*, counting the line the caret is on: an odd
 * number means a block is open. That is what makes "type ``` then Enter" open one —
 * the line being finished is itself a fence — and "type the closing ``` then Enter"
 * send it: the count is even again.
 */
export const insideFence = (textBeforeCaret: string): boolean => {
  let fences = 0;
  for (const line of textBeforeCaret.split('\n')) {
    if (FENCE_LINE.test(line)) fences += 1;
  }
  return fences % 2 === 1;
};

/**
 * The broadcast mention the text contains, as typed, or null — read the way the server reads it:
 * in the prose of the tree, not in code or a link (#330). A body the engine does not format is left
 * to the server, which is the authority either way.
 */
export const broadcastMention = (text: string): string | null => {
  const tree = parseMarkdown(text);
  const name =
    tree === null
      ? undefined
      : proseNames(tree).find((found) => BROADCAST_NAMES.has(found.toLowerCase()));
  return name === undefined ? null : `@${name}`;
};

/** How many UTF-16 code units the text is over the limit; zero or less means it fits. */
export const unitsOver = (text: string): number => text.length - MESSAGE_CONTENT_MAX;

/** How many are left before the limit, or null while the counter would only be noise. */
export const unitsLeft = (text: string): number | null => {
  const left = MESSAGE_CONTENT_MAX - text.length;
  return left <= COUNTER_FROM_REMAINING ? left : null;
};

/** Trailing whitespace only: what a person typed inside the message is never altered. */
export const trimEnd = (text: string): string => text.replace(/\s+$/, '');

/** Whether a paste is long enough to become a block. */
export const isLongPaste = (pasted: string): boolean =>
  pasted.split('\n').length > PASTE_FENCE_AFTER_LINES;

/**
 * The paste as a fenced block. The fence is one backtick longer than the longest run
 * the paste itself contains at the start of a line, so pasting a Markdown file with its
 * own fences cannot close the block early.
 */
export const asCodeBlock = (pasted: string): string => {
  let longest = 2;
  for (const line of pasted.split('\n')) {
    const run = /^`+/.exec(line)?.[0].length ?? 0;
    if (run > longest) longest = run;
  }
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${pasted.replace(/\n+$/, '')}\n${fence}`;
};

/** Rows to show: as many as the lines, within the bounds that keep the composer a line and not a page. */
export const rowsFor = (text: string, min = 2, max = 12): number =>
  Math.min(max, Math.max(min, text.split('\n').length));

/** What the caret covers: a point when `start` and `end` are equal. */
export interface Selection {
  readonly start: number;
  readonly end: number;
}

/** The three buttons under the box (D-110). Each only inserts markdown the keys also type. */
export type MarkdownKind = 'bold' | 'code' | 'mention';

/**
 * The text and the caret after a button is pressed, as one pure answer so a key can share it.
 *
 * Bold wraps what is selected and keeps it selected; with nothing selected the caret waits
 * between the markers. A code block opens on a line of its own — a fence glued to the end of a
 * sentence is not a fence — around the selection or around an empty line for the caret. A mention
 * is an `@` after a space, so it never glues itself to the word before; the composer's member
 * autocomplete takes it from there.
 */
export const insertMarkdown = (
  text: string,
  selection: Selection,
  kind: MarkdownKind,
): { readonly text: string; readonly selection: Selection } => {
  const before = text.slice(0, selection.start);
  const chosen = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  const at = before.length;
  if (kind === 'bold') {
    return {
      text: `${before}**${chosen}**${after}`,
      selection: { start: at + 2, end: at + 2 + chosen.length },
    };
  }
  if (kind === 'code') {
    const lead = before === '' || before.endsWith('\n') ? '' : '\n';
    const open = `${lead}\`\`\`\n`;
    return {
      text: `${before}${open}${chosen}\n\`\`\`${after}`,
      selection: { start: at + open.length, end: at + open.length + chosen.length },
    };
  }
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const caret = at + lead.length + 1;
  return { text: `${before}${lead}@${chosen}${after}`, selection: { start: caret, end: caret } };
};
