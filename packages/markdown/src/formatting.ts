/** Source ranges for writing controls, read with the renderer's engine and safety bounds. */
import type { Nodes, Root } from 'mdast';
import { blockTreeOf, syntaxTreeOf } from './engine';
import { readMarkdown } from './parse';

export type MarkdownFormat =
  'bold' | 'italic' | 'strike' | 'inlineCode' | 'bullets' | 'numbers' | 'tasks' | 'quote' | 'code';

export interface FormattingRange {
  readonly kind: MarkdownFormat;
  readonly start: number;
  readonly end: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly depth: number;
}

/** Null means the renderer shows the source literally, so no formatting may be claimed. */
export const formattingRanges = (text: string): readonly FormattingRange[] | null => {
  const roots: Root[] = [];
  const reading = readMarkdown(text, {
    blocks: blockTreeOf,
    full: (source) => {
      const root = syntaxTreeOf(source);
      roots.push(root);
      return root;
    },
  });
  const root = roots[0];
  if (reading.tree === null || root === undefined) return null;
  const ranges: FormattingRange[] = [];
  const add = (node: Nodes, kind: MarkdownFormat, depth: number, delimiter = 0): void => {
    const start = node.position?.start.offset;
    const stop = node.position?.end.offset;
    if (start === undefined || stop === undefined) return;
    let end = stop;
    // A bare list marker's trailing space is omitted from the parser's source position.
    if (node.type === 'list' || node.type === 'listItem') {
      while (text[end] === ' ' || text[end] === '\t') end++;
    }
    ranges.push({
      kind,
      start,
      end,
      contentStart: start + delimiter,
      contentEnd: end - delimiter,
      depth,
    });
  };
  const walk = (node: Nodes, depth: number): void => {
    switch (node.type) {
      case 'strong':
        add(node, 'bold', depth, 2);
        break;
      case 'emphasis':
        add(node, 'italic', depth, 1);
        break;
      case 'delete': {
        const at = node.position?.start.offset ?? 0;
        add(node, 'strike', depth, text[at + 1] === '~' ? 2 : 1);
        break;
      }
      case 'inlineCode': {
        const at = node.position?.start.offset ?? 0;
        let width = 0;
        while (text[at + width] === '`') width++;
        add(node, 'inlineCode', depth, width);
        break;
      }
      case 'code':
        add(node, 'code', depth);
        break;
      case 'blockquote':
        add(node, 'quote', depth);
        break;
      case 'list': {
        const tasks = node.children.filter((item) => item.checked != null).length;
        const kind =
          tasks === node.children.length ? 'tasks' : node.ordered ? 'numbers' : 'bullets';
        if (tasks === 0 || tasks === node.children.length) add(node, kind, depth);
        for (const item of node.children) {
          add(
            item,
            item.checked != null ? 'tasks' : node.ordered ? 'numbers' : 'bullets',
            depth + 1,
          );
        }
        break;
      }
      case 'break':
      case 'definition':
      case 'footnoteDefinition':
      case 'footnoteReference':
      case 'heading':
      case 'html':
      case 'image':
      case 'imageReference':
      case 'link':
      case 'linkReference':
      case 'listItem':
      case 'paragraph':
      case 'root':
      case 'table':
      case 'tableCell':
      case 'tableRow':
      case 'text':
      case 'thematicBreak':
      case 'yaml':
        break; // Other nodes do not define a toolbar format.
    }
    if ('children' in node)
      node.children.forEach((child) => {
        walk(child, depth + 1);
      });
  };
  walk(root, 0);
  return ranges;
};
