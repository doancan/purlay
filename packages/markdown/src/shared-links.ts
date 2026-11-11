/** Index the links people can open in the rendered conversation, including corporate intranet URLs. No fetches. */
import { MESSAGE_CONTENT_MAX, type SharedLink } from '@purlay/types';
import type { Block, Inline, MessageTree } from './tree';

const labelOf = (nodes: readonly Inline[]): string =>
  nodes
    .map((node) => {
      if (node.type === 'text' || node.type === 'inlineCode') return node.value;
      if ('children' in node) return labelOf(node.children);
      return ' ';
    })
    .join('');

export const sharedLinksOf = (tree: MessageTree | null): readonly SharedLink[] => {
  if (tree === null) return [];
  const links: SharedLink[] = [];
  const seen = new Set<string>();
  const inline = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      if (node.type === 'link') {
        const url = new URL(node.url.href);
        if (
          (url.protocol === 'http:' || url.protocol === 'https:') &&
          url.username === '' &&
          url.password === '' &&
          !seen.has(url.href)
        ) {
          seen.add(url.href);
          links.push({
            url: url.href,
            label: (labelOf(node.children).replace(/\s+/gu, ' ').trim() || url.href).slice(
              0,
              MESSAGE_CONTENT_MAX,
            ),
          });
        }
      }
      if ('children' in node) inline(node.children);
    }
  };
  const blocks = (nodes: readonly Block[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph':
        case 'heading':
          inline(node.children);
          break;
        case 'blockquote':
          blocks(node.children);
          break;
        case 'list':
          for (const item of node.children) blocks(item.children);
          break;
        case 'table':
          for (const row of node.children) for (const cell of row.children) inline(cell.children);
          break;
        case 'code':
        case 'thematicBreak':
          break;
      }
    }
  };
  blocks(tree.children);
  return links;
};
