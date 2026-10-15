/**
 * A message as one line a list can show (#651): the search results, the inbox, saved messages, the
 * pins and the open questions draw an excerpt, and an excerpt is what a reader sees — a code span by
 * its contents, a link by its label, emphasis without its marks — never the backticks and asterisks
 * that were typed. It is read from the same tree the feed draws, so the two cannot disagree on what a
 * message says.
 */
import { parseMarkdown } from './parse';
import type { Block, Inline, MessageTree } from './tree';

const spell = (nodes: readonly Inline[]): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
        case 'inlineCode':
          return node.value;
        case 'emphasis':
        case 'strong':
        case 'delete':
        case 'link':
          return spell(node.children);
        case 'break':
          return ' ';
      }
    })
    .join('');

const words = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block): string[] => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        return [spell(block.children)];
      case 'code':
        return [block.value];
      case 'blockquote':
        return words(block.children);
      case 'list':
        return block.children.flatMap((item) => words(item.children));
      case 'table':
        return block.children.flatMap((row) => row.children.map((cell) => spell(cell.children)));
      case 'thematicBreak':
        return [];
    }
  });

/** One line: every run of white space, line breaks included, is one space. */
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The tree's text, in reading order, on one line. */
export const plainText = (tree: MessageTree): string => oneLine(words(tree.children).join(' '));

/**
 * A message's content as an excerpt. Past the parser's bounds the feed shows a message as typed, and
 * so does its excerpt.
 */
export const excerptOf = (content: string): string => {
  const tree = parseMarkdown(content);
  return tree === null ? oneLine(content) : plainText(tree);
};
