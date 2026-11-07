/** The same bounded preview candidates for the sender's stored words and the reader's rendered tree. */
import { WEB_LINKS_PER_MESSAGE_MAX, WEB_LINK_URL_MAX } from '@purlay/types';
import { githubItemOf } from './metadata';
import type { Block, Inline, MessageTree } from './tree';

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

export const webLinksOf = (tree: MessageTree | null, appOrigin: string): readonly string[] => {
  if (tree === null) return [];
  const origin = new URL(appOrigin).origin;
  const found: string[] = [];
  const documents = new Set<string>();
  const accept = (href: string): void => {
    const url = new URL(href);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (
      href.length > WEB_LINK_URL_MAX ||
      url.protocol !== 'https:' ||
      url.origin === origin ||
      url.username !== '' ||
      url.password !== '' ||
      url.port !== '' ||
      !host.includes('.') ||
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.startsWith('[') ||
      /^[\d.]+$/.test(host) ||
      githubItemOf(href) !== null ||
      PICTURE.test(url.pathname)
    )
      return;
    url.hash = '';
    if (documents.has(url.href)) return;
    documents.add(url.href);
    found.push(href);
  };
  const inline = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      if (found.length === WEB_LINKS_PER_MESSAGE_MAX) return;
      if (node.type === 'link') accept(node.url.href);
      if ('children' in node) inline(node.children);
    }
  };
  const blocks = (nodes: readonly Block[]): void => {
    for (const node of nodes) {
      if (found.length === WEB_LINKS_PER_MESSAGE_MAX) return;
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
  return found;
};
