/**
 * What bounds the parser's cost (D-101).
 *
 * The engine is superlinear on runs of inline delimiters (measured in `docs/spikes/markdown.md`), and
 * slow, or out of stack, on containers opened
 * on one line (`1. 1. 1. …`). A body past either bound is not formatted, and is shown as typed:
 * that is a rendering decision, not a refusal, so the message is still sent, stored and searchable.
 *
 * Delimiters are counted only outside code, because a pasted file is this product's main content
 * and its underscores are not emphasis. Where code is, is the engine's answer, not this file's: an
 * earlier version found fences by pattern and the agreement test showed it could not follow a fence
 * inside a list item, so the copy of the grammar was removed rather than patched (`parse.ts`).
 */

/** Delimiters outside code beyond which a body is shown as typed. */
export const MARKDOWN_DELIMITERS_MAX = 1000;

/** Containers one line may open — quotation marks and list markers — beyond which a body is shown as typed. */
export const MARKDOWN_NESTING_MAX = 32;

/**
 * The longest unbroken run of the characters a bare address or email is made of, outside code,
 * beyond which a body is shown as typed. The autolink pass backtracks over such a run, so its cost
 * is quadratic in the run's length (`docs/spikes/markdown.md`); no address is this long.
 */
export const MARKDOWN_RUN_MAX = 1024;

/** What the engine counts as a line ending: `\r\n`, `\r` or `\n`. Splitting on `\n` alone let a lone `\r` hide a line. */
const LINE_ENDING = /\r\n|\r|\n/;

/** The characters of an address-like run: what the autolink pass's `[-.\w+]` matches. */
const RUN = /[-.+\w]/;

/** Every character the engine pairs or nests inline. */
const DELIMITERS: ReadonlySet<string> = new Set(['*', '_', '[', ']', '`', '~', '|', '!', '<']);

/** One container opened: optional indentation, then a quotation mark, or a list marker before a space or the end. */
const CONTAINER = /^[ \t]*(?:>|(?:[*+-]|\d{1,9}[.)])(?=[ \t]|$))/;

/** Containers opened at the start of one line. Linear: each step consumes what it matched. */
const nestingOf = (line: string): number => {
  let nesting = 0;
  let rest = line;
  for (let step = CONTAINER.exec(rest); step !== null; step = CONTAINER.exec(rest)) {
    nesting += 1;
    if (nesting > MARKDOWN_NESTING_MAX) return nesting;
    rest = rest.slice(step[0].length);
  }
  return nesting;
};

/** Whether some line opens more containers than the engine is allowed to nest. Checked before any parse. */
export const nestsTooDeep = (text: string): boolean =>
  text.split(LINE_ENDING).some((line) => nestingOf(line) > MARKDOWN_NESTING_MAX);

/** A half-open range of offsets, `[start, end)`, the engine read as code. */
export interface CodeRange {
  readonly start: number;
  readonly end: number;
}

/** What the inline reading will cost, measured outside code. */
export interface ProseMeasure {
  /** Inline delimiters. */
  readonly delimiters: number;
  /** The longest unbroken address-like run. */
  readonly longestRun: number;
}

/** Measures the text outside the given code ranges, which are in order and do not overlap. One pass. */
export const measureOutside = (text: string, code: readonly CodeRange[]): ProseMeasure => {
  let delimiters = 0;
  let longestRun = 0;
  let run = 0;
  let next = 0;
  for (let at = 0; at < text.length; at += 1) {
    const range = code[next];
    if (range !== undefined && at >= range.start) {
      at = range.end - 1;
      next += 1;
      run = 0;
      continue;
    }
    const character = text.charAt(at);
    if (DELIMITERS.has(character)) delimiters += 1;
    run = RUN.test(character) ? run + 1 : 0;
    if (run > longestRun) longestRun = run;
  }
  return { delimiters, longestRun };
};
