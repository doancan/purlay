/**
 * The engine, configured (D-101): micromark through `mdast-util-from-markdown`, the core
 * `remark-parse` wraps, with the GFM extensions the product renders and nothing else.
 */
import type { Nodes, Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmAutolinkLiteralFromMarkdown } from 'mdast-util-gfm-autolink-literal';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmAutolinkLiteral } from 'micromark-extension-gfm-autolink-literal';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { nestsTooDeep, type CodeRange } from './scan';

/**
 * CommonMark constructs that are never recognised (D-101):
 * raw HTML (both kinds), reference definitions (and so every reference link and image), images,
 * indented code (only a fence makes code), setext headings (only `#` makes a heading), and
 * character references (`&lt;` is four characters, as typed). Footnotes are not enabled either.
 */
const NEVER = [
  'htmlFlow',
  'htmlText',
  'definition',
  'labelStartImage',
  'codeIndented',
  'setextUnderline',
  'characterReference',
];
const DISABLED = { disable: { null: NEVER } };

/**
 * The same engine with every inline construct off as well: block structure only, which is linear
 * where the inline resolution is not (`docs/spikes/markdown.md`). It answers one question — where
 * the code is — before the full reading is allowed to run.
 */
const BLOCKS_ONLY = {
  disable: {
    null: [
      ...NEVER,
      'attention',
      'autolink',
      'characterEscape',
      'codeText',
      'hardBreakEscape',
      'hardBreakTrailing',
      'labelStartLink',
      'labelEnd',
    ],
  },
};

/** The ranges of fenced code in a tree the engine made, in order. */
export const codeRangesOf = (tree: Root): CodeRange[] => {
  const ranges: CodeRange[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === 'code') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
      return;
    }
    if ('children' in node) node.children.forEach(walk);
  };
  walk(tree);
  return ranges;
};

/** The block structure alone: where the code is, read cheaply. */
export const blockTreeOf = (text: string, onFence?: (offset: number) => void): Root =>
  // Tables are block structure: without them, a line the full reading takes as a table row could be
  // a fence here (found by the agreement test). Measured linear: 26 ms at worst on 16k of rows.
  fromMarkdown(text, {
    extensions: [gfmTable(), BLOCKS_ONLY],
    mdastExtensions: [
      gfmTableFromMarkdown(),
      { enter: { codeFencedFence: (token): void => onFence?.(token.start.offset) } },
    ],
  });

/**
 * Whether the caret at the end is in unfinished fenced code. Observe the engine's fence tokens:
 * one opens a block, a second closes it. This also follows indentation, containers, tilde fences
 * and fence lengths without maintaining a second Markdown grammar in the composer (D-101).
 */
export const endsInOpenCode = (text: string): boolean => {
  if ((!text.includes('```') && !text.includes('~~~')) || nestsTooDeep(text)) return false;
  const fences: number[] = [];
  const tree = blockTreeOf(text, (offset): void => {
    fences.push(offset);
  });
  const last = codeRangesOf(tree).at(-1);
  return last?.end === text.length && fences.filter((offset) => offset >= last.start).length === 1;
};

/** The full reading. Only ever run inside the bounds `parse.ts` checks first. */
export const syntaxTreeOf = (text: string): Root =>
  fromMarkdown(text, {
    extensions: [gfmAutolinkLiteral(), gfmStrikethrough(), gfmTable(), gfmTaskListItem(), DISABLED],
    mdastExtensions: [
      gfmAutolinkLiteralFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
    ],
  });
