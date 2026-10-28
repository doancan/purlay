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
import { BROADCAST_NAMES, endsInOpenCode, parseMarkdown, proseNames } from '@purlay/markdown';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';

/** How many lines a paste may have before it is made a code block (`UX.md` §5). */
const PASTE_FENCE_AFTER_LINES = 12;

/** The counter appears this close to the limit and not before: it is noise until it matters. */
const COUNTER_FROM_REMAINING = 500;

/** The renderer's own block grammar decides whether Enter continues code or sends. */
export const insideFence = endsInOpenCode;

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
    const run = /^ {0,3}(`+)/.exec(line)?.[1]?.length ?? 0;
    if (run > longest) longest = run;
  }
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${pasted}\n${fence}`;
};

/** Rows to show: as many as the lines, within the bounds that keep the composer a line and not a page. */
export const rowsFor = (text: string, min = 2, max = 12): number =>
  Math.min(max, Math.max(min, text.split('\n').length));

/** What the caret covers: a point when `start` and `end` are equal. */
export interface Selection {
  readonly start: number;
  readonly end: number;
}

/**
 * What a button or a key inserts (D-110, D-181). Each is markdown the renderer draws and nothing else —
 * there is no editor here, only text put where the caret is. `code` is a fenced block; `inlineCode` a span.
 */
export type MarkdownKind =
  | 'bold'
  | 'italic'
  | 'strike'
  | 'inlineCode'
  | 'link'
  | 'bullets'
  | 'numbers'
  | 'quote'
  | 'code'
  | 'mention';

/** The text and the caret after a button or a key: one pure answer, shared by both. */
export interface Inserted {
  readonly text: string;
  readonly selection: Selection;
}

const WRAPS = { bold: '**', italic: '_', strike: '~~' } as const;

/**
 * `mark` around the selection, keeping it selected — or taken off again when the selection already is
 * one (the markers inside it) or sits inside one (the markers just outside it). With nothing selected the
 * caret waits between the markers.
 */
const wrap = (text: string, selection: Selection, mark: string): Inserted => {
  const before = text.slice(0, selection.start);
  const chosen = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  const width = mark.length;
  if (chosen.length >= 2 * width && chosen.startsWith(mark) && chosen.endsWith(mark)) {
    const inner = chosen.slice(width, chosen.length - width);
    return {
      text: before + inner + after,
      selection: { start: before.length, end: before.length + inner.length },
    };
  }
  if (before.endsWith(mark) && after.startsWith(mark)) {
    const start = before.length - width;
    return {
      text: before.slice(0, start) + chosen + after.slice(width),
      selection: { start, end: start + chosen.length },
    };
  }
  return {
    text: `${before}${mark}${chosen}${mark}${after}`,
    selection: { start: before.length + width, end: before.length + width + chosen.length },
  };
};

/** `value` where the selection is — in its place — with the caret after it: an emoji from the picker. */
export const insertText = (text: string, selection: Selection, value: string): Inserted => ({
  text: text.slice(0, selection.start) + value + text.slice(selection.end),
  selection: { start: selection.start + value.length, end: selection.start + value.length },
});

/** A line's own marker of each kind, and the one that is any of them. */
const LINE_MARKER: Readonly<Record<'bullets' | 'numbers' | 'quote', RegExp>> = {
  bullets: /^[-*+] /,
  numbers: /^\d+\. /,
  quote: /^> /,
};
const ANY_MARKER = /^(?:[-*+] |\d+\. |> )/;

/**
 * A marker on every line the selection touches — whole lines, whatever part of them is selected — or
 * taken off all of them when each already has it. A line with another kind of marker is changed to this
 * one. Quotes keep the original markers and quote blank lines too, preserving lists and paragraphs.
 */
const marked = (
  text: string,
  selection: Selection,
  kind: 'bullets' | 'numbers' | 'quote',
): Inserted => {
  const first = selection.start === 0 ? 0 : text.lastIndexOf('\n', selection.start - 1) + 1;
  const stop = text.indexOf('\n', Math.max(selection.start, selection.end - 1));
  const last = stop === -1 ? text.length : stop;
  const lines = text.slice(first, last).split('\n');
  const named = lines.filter((line) => line !== '');
  if (selection.start === selection.end && named.length === 0) {
    // The caret on a blank line: the button starts the list there. Blank lines inside a selection
    // still take none, so a block of paragraphs is marked paragraph by paragraph.
    const marker = kind === 'bullets' ? '- ' : kind === 'numbers' ? '1. ' : '> ';
    const caret = first + marker.length;
    return {
      text: text.slice(0, first) + marker + text.slice(last),
      selection: { start: caret, end: caret },
    };
  }
  const off = named.length > 0 && named.every((line) => LINE_MARKER[kind].test(line));
  let number = 0;
  const changed = lines.map((line) => {
    if (kind === 'quote') return off ? line.replace(LINE_MARKER.quote, '') : `> ${line}`;
    if (line === '') return line;
    const bare = line.replace(ANY_MARKER, '');
    if (off) return bare;
    number += 1;
    return `${kind === 'bullets' ? '- ' : `${String(number)}. `}${bare}`;
  });
  const block = changed.join('\n');
  const result = text.slice(0, first) + block + text.slice(last);
  if (selection.start !== selection.end) {
    return { text: result, selection: { start: first, end: first + block.length } };
  }
  // Nothing selected: the caret stays where it was in the line, which has moved by what was added or taken.
  const caret = Math.max(first, selection.start + (block.length - (last - first)));
  return { text: result, selection: { start: caret, end: caret } };
};

const URLISH = /^https?:\/\/\S+$/;

/**
 * The text and the caret after a button is pressed, as one pure answer so a key can share it.
 *
 * Bold, italic and strike wrap what is selected and keep it selected, or take their markers off again; with
 * nothing selected the caret waits between them. Inline code does the same with backticks — a longer run
 * and a space when the words hold a backtick, and a block when they hold a line break. A link is a
 * template: an address that was selected becomes its target and asks for the words; words become its label
 * and ask for the address. A list or a quote marks whole lines. A code block opens and closes on lines of
 * its own — a fence glued to a sentence is not a fence — around the selection or around an empty line for
 * the caret. A mention is an `@` after a space, so it never glues itself to the word before; the first
 * letter typed after it opens the list of people (`mention-suggest.ts`, `UX.md` §5).
 */
export const insertMarkdown = (
  text: string,
  selection: Selection,
  kind: MarkdownKind,
): Inserted => {
  const before = text.slice(0, selection.start);
  const chosen = text.slice(selection.start, selection.end);
  const after = text.slice(selection.end);
  const at = before.length;
  if (kind === 'bold' || kind === 'italic' || kind === 'strike') {
    return wrap(text, selection, WRAPS[kind]);
  }
  if (kind === 'inlineCode') {
    if (chosen.includes('\n')) return insertMarkdown(text, selection, 'code');
    const toggles =
      /^`[^`]+`$/.test(chosen) ||
      (before.endsWith('`') && after.startsWith('`') && !chosen.includes('`'));
    if (toggles || !chosen.includes('`')) return wrap(text, selection, '`');
    const longest = Math.max(...(chosen.match(/`+/g) ?? []).map((run) => run.length));
    const fence = '`'.repeat(longest + 1);
    const start = at + fence.length + 1;
    return {
      text: `${before}${fence} ${chosen} ${fence}${after}`,
      selection: { start, end: start + chosen.length },
    };
  }
  if (kind === 'link') {
    if (URLISH.test(chosen)) {
      return {
        text: `${before}[text](${chosen})${after}`,
        selection: { start: at + 1, end: at + 5 },
      };
    }
    const label = chosen === '' ? 'text' : chosen;
    const start = chosen === '' ? at + 1 : at + label.length + 3;
    return {
      text: `${before}[${label}](https://)${after}`,
      selection: { start, end: start + (chosen === '' ? 4 : 8) },
    };
  }
  if (kind === 'bullets' || kind === 'numbers' || kind === 'quote') {
    return marked(text, selection, kind);
  }
  if (kind === 'code') {
    const lead = before === '' || before.endsWith('\n') ? '' : '\n';
    // A closing fence with words after it is not one, and would swallow the rest of the message.
    const trail = after === '' || after.startsWith('\n') ? '' : '\n';
    const block = asCodeBlock(chosen);
    const openLength = lead.length + block.indexOf('\n') + 1;
    return {
      text: `${before}${lead}${block}${trail}${after}`,
      selection: { start: at + openLength, end: at + openLength + chosen.length },
    };
  }
  const lead = before === '' || /\s$/.test(before) ? '' : ' ';
  const caret = at + lead.length + 1;
  return { text: `${before}${lead}@${chosen}${after}`, selection: { start: caret, end: caret } };
};

/** Long, unformatted pastes become code; existing code keeps the browser's ordinary paste. */
export const formatPaste = (
  text: string,
  selection: Selection,
  pasted: string,
): Inserted | null => {
  if (!isLongPaste(pasted) || insideFence(text.slice(0, selection.start))) return null;
  const tree = parseMarkdown(pasted);
  if (tree?.children.length === 1 && tree.children[0]?.type === 'code') return null;
  const raw = insertText(text, selection, pasted);
  const formatted = insertMarkdown(
    raw.text,
    { start: selection.start, end: raw.selection.end },
    'code',
  );
  const end = formatted.text.length - (text.length - selection.end);
  return { text: formatted.text, selection: { start: end, end } };
};

/** Undo only an unchanged, uniquely identifiable insertion; never restore an old draft over later edits. */
export const undoPaste = (text: string, formatted: string, pasted: string): Inserted | null => {
  const start = text.indexOf(formatted);
  if (start < 0 || text.includes(formatted, start + 1)) return null;
  return insertText(text, { start, end: start + formatted.length }, pasted);
};

/** A list or a quote's own marker at the start of a line: its indent, its kind, and the text it takes. */
const CONTINUING = /^(\s*)(?:([-*+])|(\d+)\.|(>)) /;

/**
 * What Shift+Enter does in a list or a quote: the line break, and the next marker already on the new line —
 * the next number for a numbered one. On an item that has only its marker it takes the marker away instead,
 * which is how a list is ended. `null` where the line is no list (or the caret is in a code fence, where a
 * dash is not one): the browser's own line break is right there.
 */
export const continueList = (
  text: string,
  caret: number,
): { readonly text: string; readonly caret: number } | null => {
  if (insideFence(text.slice(0, caret))) return null;
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const lineBefore = text.slice(lineStart, caret);
  const found = CONTINUING.exec(lineBefore);
  if (found === null) return null;
  const marker = found[0];
  if (lineBefore === marker) {
    // An empty item: the marker goes, and the list is over.
    return { text: text.slice(0, lineStart) + text.slice(caret), caret: lineStart };
  }
  const indent = found[1] ?? '';
  const next =
    found[3] !== undefined
      ? `${indent}${String(Number(found[3]) + 1)}. `
      : `${indent}${found[2] ?? found[4] ?? '-'} `;
  return {
    text: `${text.slice(0, caret)}\n${next}${text.slice(caret)}`,
    caret: caret + 1 + next.length,
  };
};

/** The parts of a keyboard event a formatting key is read from: nothing the DOM adds. */
export interface KeyLike {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** On a keyboard event itself: whether AltGraph is down (the DOM's own question; AltGr is Ctrl+Alt on Windows). */
  readonly getModifierState?: (key: 'AltGraph') => boolean;
}

/**
 * What a key asks for in the box, or `null` when it is only typing (D-181). Either of Ctrl and Meta, as the
 * palette's key is read, so the behaviour never depends on the platform — only the tooltip's words do.
 * Ctrl+K is not here: it is the palette's. The digit keys are read by their *position* (`code`), since
 * Shift turns a digit into a different character on every layout, and so is the one letter that needs
 * Alt as well: Ctrl/Meta+Alt+Shift+C is a code block (Slack's chord; plain Ctrl+Shift+C is the browser's
 * inspector, which a page cannot have). AltGr is Ctrl+Alt on Windows, and on some layouts (Polish
 * programmer's, for one) AltGr+Shift+C types a letter, so a chord the browser says is AltGraph is typing.
 */
export const formatKey = (event: KeyLike): Exclude<MarkdownKind, 'mention'> | 'preview' | null => {
  if (!(event.ctrlKey || event.metaKey)) return null;
  if (event.altKey) {
    const chord = event.shiftKey && event.code === 'KeyC';
    return chord && event.getModifierState?.('AltGraph') !== true ? 'code' : null;
  }
  const letter = event.key.toLowerCase();
  if (!event.shiftKey) {
    if (letter === 'b') return 'bold';
    if (letter === 'i') return 'italic';
    if (letter === 'e') return 'inlineCode';
    return null;
  }
  if (letter === 'x') return 'strike';
  if (letter === 'u') return 'link';
  if (letter === 'p') return 'preview';
  if (event.code === 'Digit8') return 'bullets';
  if (event.code === 'Digit7') return 'numbers';
  if (event.code === 'Digit9') return 'quote';
  return null;
};

/**
 * What Enter does, in the composer and in the editor of a sent message alike (D-188): Shift+Enter is a
 * new line; Ctrl/Meta+Enter sends wherever the caret is; a plain Enter sends too, except inside a code
 * fence that is still open, where it is a new line — a block of code is written a line at a time, and
 * sending it half-typed is the one thing nobody meant. On a device that is only touch (`touchOnly`), a
 * plain Enter is a new line too: a phone's keyboard has no Shift+Enter, so without this there is no way to
 * write a second line, and Send is a button there. `null` for any other key.
 */
export const enterAction = (
  event: KeyLike,
  textBeforeCaret: string,
  touchOnly = false,
): 'submit' | 'newline' | null => {
  if (event.key !== 'Enter') return null;
  if (event.shiftKey) return 'newline';
  if (event.metaKey || event.ctrlKey) return 'submit';
  return touchOnly || insideFence(textBeforeCaret) ? 'newline' : 'submit';
};

/**
 * A backtick typed over a selection wraps it in inline code instead of replacing it, as Slack does —
 * the words are not lost to a keystroke. Ctrl+Alt is AltGr on Windows, where some layouts type the
 * backtick itself, so it is let through; Ctrl or Meta alone is a shortcut and is not ours.
 */
export const typedWrap = (event: KeyLike, selection: Selection): 'inlineCode' | null => {
  if (event.key !== '`' || selection.start === selection.end) return null;
  if (event.metaKey || (event.ctrlKey && !event.altKey)) return null;
  return 'inlineCode';
};
