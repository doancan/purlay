/**
 * Where a mention can be (#330, D-101 §7): the prose of the tree the client draws.
 *
 * Each block's inline content is spelled out as one string, with every code span and every link
 * standing as a single backtick. `mentionsIn` already refuses a name preceded by a backtick, so a
 * name inside code, inside a link (its label or its address), or glued to the end of either is not
 * found — and what remains is exactly the prose a person reads as addressed to someone. The server
 * resolves these names and the client highlights in the same prose, so what notifies and what is
 * drawn as a mention come from one reading.
 */
import { mentionsIn } from './mentions';
import type { Block, Inline, MessageTree } from './tree';

/** Code and links are not prose: each stands for one backtick, which no name may follow. */
const OPAQUE = '`';

const spell = (nodes: readonly Inline[]): string =>
  nodes
    .map((node): string => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'inlineCode':
        case 'link':
          return OPAQUE;
        case 'emphasis':
        case 'strong':
        case 'delete':
          return spell(node.children);
        case 'break':
          return '\n';
      }
    })
    .join('');

/** The prose strings of the blocks, in reading order; a fence has none. */
const proseOf = (blocks: readonly Block[]): string[] =>
  blocks.flatMap((block): string[] => {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        return [spell(block.children)];
      case 'blockquote':
        return proseOf(block.children);
      case 'list':
        return block.children.flatMap((item) => proseOf(item.children));
      case 'table':
        return block.children.flatMap((row) => row.children.map((cell) => spell(cell.children)));
      case 'code':
      case 'thematicBreak':
        return [];
    }
  });

/** Every mention-shaped name in the tree's prose, as written, in reading order. */
export const proseNames = (tree: MessageTree): string[] =>
  proseOf(tree.children).flatMap((prose) => mentionsIn(prose).map((span) => span.name));
