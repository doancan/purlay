/**
 * Typed faces become emoji (D-253): `:D` turns into 😄 once the word ends — at a space, a new line or
 * the send — and only when it stands alone, so `:Dosya` and `http://a.b:D` are left as written. Never
 * inside code, where `:)` is somebody's syntax. A Backspace straight after the change puts the face
 * back as it was typed, and that one stays (the composer keeps the undo; this module answers what).
 *
 * Pure and linear: the text is up to 16,000 characters, and nothing here scans more than the line
 * the caret is on, plus the fence check the composer already makes for Enter.
 */
import { endsInOpenCode } from '@purlay/markdown';

/** Each face as it is typed, case and all, and the emoji it becomes. */
export const EMOTICONS: ReadonlyMap<string, string> = new Map([
  [':)', '🙂'],
  [':-)', '🙂'],
  [':D', '😄'],
  [':-D', '😄'],
  [';)', '😉'],
  [';-)', '😉'],
  [':(', '🙁'],
  [':-(', '🙁'],
  [':P', '😛'],
  [':p', '😛'],
  [':-P', '😛'],
  [':-p', '😛'],
  [';P', '😜'],
  [';p', '😜'],
  [';-P', '😜'],
  [';-p', '😜'],
  [':O', '😮'],
  [':o', '😮'],
  [':-O', '😮'],
  [':-o', '😮'],
  [":'(", '😢'],
  [":')", '🥲'],
  [':*', '😘'],
  [':-*', '😘'],
  [':/', '😕'],
  [':-/', '😕'],
  [':|', '😐'],
  [':-|', '😐'],
  [':S', '😖'],
  [':s', '😖'],
  [':$', '😳'],
  ['>:(', '😠'],
  ['O:)', '😇'],
  ['O:-)', '😇'],
  ['B-)', '😎'],
  ['xD', '😆'],
  ['XD', '😆'],
  ['^_^', '😊'],
  ['^^', '😊'],
  ['-_-', '😑'],
  ['T_T', '😭'],
  ['<3', '❤️'],
  ['</3', '💔'],
  ['\\o/', '🙌'],
  ['o/', '👋'],
]);

const LONGEST = Math.max(...[...EMOTICONS.keys()].map((typed) => typed.length));

/** A face found in the text: where it is, what was typed and what it becomes. */
export interface Emoticon {
  readonly start: number;
  readonly end: number;
  readonly typed: string;
  readonly emoji: string;
}

const isSpace = (character: string | undefined): boolean =>
  character === ' ' || character === '\n' || character === '\t';

/** Inside code: an open fence above, or an odd count of backticks earlier on the line. */
const inCode = (text: string, at: number): boolean => {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  let ticks = 0;
  for (let index = lineStart; index < at; index++) if (text[index] === '`') ticks++;
  return ticks % 2 === 1 || endsInOpenCode(text.slice(0, at));
};

/**
 * The face whose last character is just before `end`, standing alone (the start of the text or a
 * space before it), outside code — or null.
 */
export const emoticonEndingAt = (text: string, end: number): Emoticon | null => {
  let start = end;
  // No further back than the longest face: a long word is not walked to its start.
  while (start > 0 && end - start <= LONGEST && !isSpace(text[start - 1])) start--;
  const typed = text.slice(start, end);
  const emoji = EMOTICONS.get(typed);
  if (emoji === undefined || inCode(text, start)) return null;
  return { start, end, typed, emoji };
};

/** The text with the face replaced by its emoji. */
const withEmoji = (text: string, face: Emoticon): string =>
  text.slice(0, face.start) + face.emoji + text.slice(face.end);

/**
 * What one keystroke turned `before` into, if it ended a face: a single space or new line typed
 * after one. Null for anything else — a paste, a deletion, a letter.
 */
export const typedAfterFace = (
  before: string,
  after: string,
  caret: number,
): { readonly face: Emoticon; readonly text: string; readonly caret: number } | null => {
  if (after.length !== before.length + 1 || caret < 1 || !isSpace(after[caret - 1])) return null;
  if (after.slice(0, caret - 1) + after.slice(caret) !== before) return null;
  const face = emoticonEndingAt(after, caret - 1);
  if (face === null) return null;
  return {
    face,
    text: withEmoji(after, face),
    caret: caret - face.typed.length + face.emoji.length,
  };
};

/** The text as it is sent: a face that ends it becomes its emoji, as the space would have made it. */
export const withClosingEmoji = (text: string): string => {
  const face = emoticonEndingAt(text, text.length);
  return face === null ? text : withEmoji(text, face);
};
