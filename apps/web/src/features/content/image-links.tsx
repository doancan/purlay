/**
 * A link to an image, drawn under the message as the image (#110, `UX.md` §3) — through the API's
 * proxy, so the image's host never learns who is reading, and nothing inside the network is reached.
 *
 * - **Only what a link already is**: the links of the reading the words are drawn from (`SafeHref`,
 *   D-101), `https`, whose path ends in a picture's extension; markdown's `![…](…)` stays unrecognised
 *   (D-101), so nothing about the engine changes.
 * - At most `IMAGE_LINKS_DRAWN` per message, in the order written, each a link to the original.
 * - **A picture is decoration of a link that is already there**: one the proxy will not or cannot show
 *   draws nothing, as a missing GitHub card does.
 */
import type { Block, Inline } from '@purlay/markdown';
import { useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { readBody } from './render-content';

/** The most pictures one message shows; the rest stay links. */
export const IMAGE_LINKS_DRAWN = 3;

const PICTURE = /\.(png|jpe?g|gif|webp)$/i;

const linksIn = (blocks: readonly Block[]): string[] => {
  const found: string[] = [];
  const inline = (nodes: readonly Inline[]): void => {
    for (const node of nodes) {
      if (node.type === 'link') found.push(node.url.href);
      if ('children' in node) inline(node.children);
    }
  };
  const block = (nodes: readonly Block[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'paragraph':
        case 'heading':
          inline(node.children);
          break;
        case 'blockquote':
          block(node.children);
          break;
        case 'list':
          for (const item of node.children) block(item.children);
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
  block(blocks);
  return found;
};

/** The picture links of a message's words, unique, in order, at most `IMAGE_LINKS_DRAWN`. */
export const pictureLinksOf = (content: string): readonly string[] => {
  const tree = readBody(content).tree;
  if (tree === null) return [];
  const pictures = linksIn(tree.children).filter((href) => {
    const url = new URL(href);
    return url.protocol === 'https:' && PICTURE.test(url.pathname);
  });
  return [...new Set(pictures)].slice(0, IMAGE_LINKS_DRAWN);
};

const Picture = ({ href }: { readonly href: string }): React.JSX.Element | null => {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const host = new URL(href).hostname;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-attachment rounded-xl"
    >
      <img
        src={`/api/images?url=${encodeURIComponent(href)}`}
        alt={t('message.imageFrom', { host })}
        loading="lazy"
        decoding="async"
        // Within the attachment's square, whatever the picture's own shape.
        className="block max-h-attachment max-w-full rounded-xl border-hairline border-border-subtle bg-surface-200 shadow-card"
        onError={() => {
          setFailed(true);
        }}
      />
    </a>
  );
};

export const ImageLinks = ({ content }: { readonly content: string }): React.JSX.Element | null => {
  const links = pictureLinksOf(content);
  if (links.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {links.map((href) => (
        <Picture key={href} href={href} />
      ))}
    </div>
  );
};
