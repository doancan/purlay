/**
 * What the server records about a text message when it is written (`SCHEMA.md` §6.4): derived
 * once from the tree, so the feed does not derive it again (D-36).
 */
import { GITHUB_LINKS_PER_MESSAGE_MAX, type TextMetadata } from '@purlay/types';
import type { Block, Inline, MessageTree } from './tree';

/**
 * A pull request or issue on github.com, and nothing else: an owner and a repository with
 * GitHub's shapes, then `pull` or `issues` and a number. What follows — `/files`, a fragment —
 * is the same item.
 */
const GITHUB_ITEM =
  /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/(pull|issues)\/(\d{1,10})(?:\/|$)/;
const GITHUB_HOSTS: ReadonlySet<string> = new Set(['github.com', 'www.github.com']);

/** The canonical address of a GitHub item, or null for any other link. */
const githubItemOf = (url: string): string | null => {
  if (!URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (!GITHUB_HOSTS.has(parsed.hostname)) return null;
  const match = GITHUB_ITEM.exec(parsed.pathname);
  if (match === null) return null;
  const [, owner, repo, kind, number] = match;
  return `https://github.com/${owner ?? ''}/${repo ?? ''}/${kind ?? ''}/${number ?? ''}`;
};

export const metadataOf = (tree: MessageTree | null): TextMetadata => {
  if (tree === null) return {};
  const languages: string[] = [];
  const links: string[] = [];

  const inline = (node: Inline): void => {
    if (node.type === 'link') {
      const item = githubItemOf(node.url.href);
      if (item !== null && !links.includes(item) && links.length < GITHUB_LINKS_PER_MESSAGE_MAX) {
        links.push(item);
      }
    }
    if ('children' in node) node.children.forEach(inline);
  };
  const block = (node: Block): void => {
    switch (node.type) {
      case 'code':
        languages.push(node.lang ?? '');
        return;
      case 'paragraph':
      case 'heading':
        node.children.forEach(inline);
        return;
      case 'blockquote':
        node.children.forEach(block);
        return;
      case 'list':
        node.children.forEach((item) => {
          item.children.forEach(block);
        });
        return;
      case 'table':
        node.children.forEach((row) => {
          row.children.forEach((cell) => {
            cell.children.forEach(inline);
          });
        });
        return;
      case 'thematicBreak':
        return;
    }
  };
  tree.children.forEach(block);

  const [only] = tree.children;
  return {
    ...(languages.length > 0 ? { codeLanguages: languages } : {}),
    ...(links.length > 0 ? { githubLinks: links } : {}),
    ...(tree.children.length === 1 && only?.type === 'code' ? { isCodeOnly: true } : {}),
  };
};
