/** Keep origin requests tied to a visible message, and preserve its height after the first draw. */
import { useEffect, useRef, useState } from 'react';
import type { WebLinkCardsProps } from './web-link-cards';
import Cards from './web-link-cards-content';

const VisibleCards = (props: WebLinkCardsProps): React.JSX.Element => {
  const node = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ seen: false, visible: false });
  useEffect(() => {
    // The message has a box even when the optional card is absent; reserve no placeholder height.
    const target = node.current?.parentElement;
    if (target === null || target === undefined) return;
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
    <div ref={node} data-web-link-cards="" className="w-full min-w-0">
      {view.seen && <Cards {...props} visible={view.visible} />}
    </div>
  );
};

export default VisibleCards;
