/**
 * The bounds in front of the full reading (D-101).
 *
 * The engine is superlinear on inline delimiters and slow, or out of stack, on containers opened on
 * one line. A body past either bound is shown as typed. Delimiters inside code are not counted — a
 * pasted file is not emphasis — and where code is comes from the engine's own block reading.
 */
import { describe, expect, test } from 'bun:test';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import { blockTreeOf, codeRangesOf, syntaxTreeOf } from './engine';
import { readMarkdown } from './parse';
import {
  measureOutside,
  MARKDOWN_DELIMITERS_MAX,
  MARKDOWN_NESTING_MAX,
  MARKDOWN_RUN_MAX,
  nestsTooDeep,
  type CodeRange,
} from './scan';

const reason = (text: string): string | null => {
  const reading = readMarkdown(text);
  return reading.tree === null ? reading.reason : null;
};

describe('delimiters outside code', () => {
  test('at the limit the body is formatted, one more and it is shown as typed', () => {
    // Spaced, so no run of address characters forms: this measures one bound, not two.
    expect(reason('_ '.repeat(MARKDOWN_DELIMITERS_MAX))).toBeNull();
    expect(reason(`${'_ '.repeat(MARKDOWN_DELIMITERS_MAX)}_`)).toBe('delimiters');
  });

  test('every kind the engine pairs is counted', () => {
    for (const delimiter of ['*', '_', '[', ']', '`', '~', '|', '!', '<']) {
      expect(measureOutside(`${delimiter}a`.repeat(10), []).delimiters).toBe(10);
    }
  });

  test('inside a code range they are not', () => {
    expect(measureOutside('_a_`b`_', [{ start: 1, end: 6 }]).delimiters).toBe(2);
  });

  test.each([
    ['a fence', (inside: string): string => `\`\`\`python\n${inside}\n\`\`\``],
    ['a fence that is never closed', (inside: string): string => `\`\`\`\n${inside}`],
    [
      'a fence inside a list item',
      (inside: string): string => `- item\n\n  \`\`\`\n  ${inside}\n  \`\`\``,
    ],
    ['a fence inside a quotation', (inside: string): string => `> \`\`\`\n> ${inside}\n> \`\`\``],
    ['an indented fence', (inside: string): string => `      \`\`\`\n${inside}\n      \`\`\``],
  ])('a pasted file in %s is formatted: its underscores are not emphasis', (_, wrap) => {
    const line = 'def handle(self, *args, **kwargs): return self._dispatch(__name__) ';
    const inside = line.repeat(200).slice(0, 12_000);
    expect(measureOutside(inside, []).delimiters).toBeGreaterThan(MARKDOWN_DELIMITERS_MAX);
    expect(reason(wrap(inside))).toBeNull();
  });
});

describe('address-like runs outside code', () => {
  // The autolink pass backtracks over a run of the characters an address is made of: quadratic in its length.
  test('at the limit the body is formatted, one more and it is shown as typed', () => {
    expect(reason('.-'.repeat(MARKDOWN_RUN_MAX / 2))).toBeNull();
    expect(reason(`${'.-'.repeat(MARKDOWN_RUN_MAX / 2)}a`)).toBe('run');
  });

  test('a space, or a fence around it, ends the run', () => {
    expect(measureOutside('a.b c.d', []).longestRun).toBe(3);
    const long = '.-'.repeat(MARKDOWN_RUN_MAX);
    expect(reason(`\`\`\`\n${long}\n\`\`\``)).toBeNull();
    expect(reason(long.match(/.{1,100}/g)?.join(' ') ?? '')).toBeNull();
  });
});

describe('containers opened on one line', () => {
  test.each(['> ', '1. ', '- ', '* ', '+ ', '2) '])(
    'of %j: at the limit formatted, one more and shown as typed',
    (marker) => {
      expect(nestsTooDeep(`${marker.repeat(MARKDOWN_NESTING_MAX)}a`)).toBe(false);
      expect(reason(`${marker.repeat(MARKDOWN_NESTING_MAX + 1)}a`)).toBe('nesting');
    },
  );

  test.each(['\r', '\r\n'])('a line ended by %j is a line, as the engine reads it', (ending) => {
    // Splitting on \n alone let `x\r1. 1. 1. …` hide its second line: 2.3 s of CPU in the spike.
    expect(reason(`x${ending}${'1. '.repeat(MARKDOWN_NESTING_MAX + 1)}a`)).toBe('nesting');
  });

  test('indentation alone is not a container, and a number that is not a marker is not either', () => {
    expect(nestsTooDeep(`${' '.repeat(200)}a`)).toBe(false);
    expect(nestsTooDeep('12345678901 is a number, not a list')).toBe(false);
  });
});

describe('the block reading and the full one agree on where code is', () => {
  // Mulberry32: 32-bit arithmetic throughout. A linear generator in plain numbers loses its low bits
  // past 2^53; an earlier version of this test picked the same piece nineteen times in twenty.
  let seed = 7;
  const next = (): number => {
    seed = (seed + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  const pieces = [
    '```',
    '````',
    '~~~',
    '``` ts',
    '``` a`b',
    '~~~ a`b',
    '``` x ```',
    '   ```',
    '    ```',
    '\t```',
    '> ```',
    '- ```',
    '1. ```',
    '  ```',
    'text',
    '',
    '_a_',
    '`x`',
    '| a | b |',
    '|---|---|',
    '[a](',
    '*',
  ];
  const covered = (range: CodeRange, by: readonly CodeRange[]): boolean =>
    by.some((other) => other.start <= range.start && range.end <= other.end);

  test('nothing the block reading calls code is anything else to the full one', () => {
    const seen = new Set<string>();
    for (let run = 0; run < 3000; run += 1) {
      const text = Array.from(
        { length: 1 + (next() % 10) },
        () => pieces[next() % pieces.length],
      ).join('\n');
      seen.add(text);
      const full = codeRangesOf(syntaxTreeOf(text));
      const blocks = codeRangesOf(blockTreeOf(text));
      // What `measureOutside` assumes of its ranges: in order, and not overlapping.
      blocks.forEach((range, index) => {
        expect(range.start).toBeLessThanOrEqual(range.end);
        expect(range.start).toBeGreaterThanOrEqual(blocks[index - 1]?.end ?? 0);
      });
      for (const range of blocks) {
        if (!covered(range, full))
          throw new Error(
            `${JSON.stringify(text)}: ${JSON.stringify(range)} is code to the block reading only`,
          );
      }
    }
    // The generator really generated: a test of three thousand copies of one document is a test of one.
    expect(seen.size).toBeGreaterThan(2500);
  });
});

describe('the bounds keep the engine inside them', () => {
  // Not "never throws": a failure inside the engine is caught and would pass that. The claim is that
  // no hostile body of the longest length ever reaches a failure — each is formatted or bounded.
  test.each([
    '*a',
    '_a',
    '[',
    ']',
    '`a',
    '>',
    '> ',
    '1. ',
    '- ',
    '|a',
    '~a',
    ' ',
    '\\',
    '<',
    '[a](',
    '![',
    '\n',
    '```\n',
    '- ```\n',
    'a.',
    '.-',
    '+.',
    'a@',
    'x\r1. ',
    '\r> ',
  ])('on the longest body made of %j', (shape) => {
    const body = shape
      .repeat(Math.ceil(MESSAGE_CONTENT_MAX / shape.length))
      .slice(0, MESSAGE_CONTENT_MAX);
    const reading = readMarkdown(body);
    expect(reading.tree === null ? reading.reason : 'formatted').not.toBe('engine');
  });
});
