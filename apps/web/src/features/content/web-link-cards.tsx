/** Mount metadata only for rendered public links, and fetch only while their message is in view. */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { webLinksOf } from '@purlay/markdown';
import { readBody } from './render-content';

const Cards = lazy(async () => await import('./web-link-cards-content'));

export interface WebLinkCardsProps {
  readonly channelId: string;
  readonly messageId: string;
  readonly content: string;
}

const VisibleCards = ({
  channelId,
  messageId,
  links,
}: Omit<WebLinkCardsProps, 'content'> & {
  readonly links: readonly string[];
}): React.JSX.Element => {
  const node = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ seen: false, visible: false });
  useEffect(() => {
    const target = node.current;
    if (target === null) return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === target);
      if (entry === undefined) return;
      setView((old) => ({ seen: old.seen || entry.isIntersecting, visible: entry.isIntersecting }));
    });
    observer.observe(target);
    return (): void => {
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={node} data-web-link-cards="" className="min-h-1">
      {view.seen && (
        <Suspense fallback={null}>
          <Cards channelId={channelId} messageId={messageId} links={links} visible={view.visible} />
        </Suspense>
      )}
    </div>
  );
};

export const WebLinkCards = ({
  content,
  ...scope
}: WebLinkCardsProps): React.JSX.Element | null => {
  const links = webLinksOf(readBody(content).tree, window.location.origin);
  return links.length === 0 ? null : <VisibleCards {...scope} links={links} />;
};
