/** HTTPS text only hints at loading code; the lazy feature selects actual rendered links from the AST. */
import { lazy, Suspense } from 'react';
import { RenderBoundary } from '../shell/failure-boundary';

const Cards = lazy(() => import('./web-link-cards-visible'));

export interface WebLinkCardsProps {
  readonly channelId: string;
  readonly messageId: string;
  readonly content: string;
}

export const WebLinkCards = (props: WebLinkCardsProps): React.JSX.Element | null =>
  /https/i.test(props.content) ? (
    <RenderBoundary fallback={null}>
      <Suspense fallback={null}>
        <Cards {...props} />
      </Suspense>
    </RenderBoundary>
  ) : null;
