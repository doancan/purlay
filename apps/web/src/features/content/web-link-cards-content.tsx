/** Optional web metadata: plain text, original destination, proxied decorative image. */
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import type { WebLinkPreviewResponse } from '@purlay/types';
import { webLinksOf } from '@purlay/markdown';
import { readBody } from './render-content';
import type { WebLinkCardsProps } from './web-link-cards';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';

const Cover = ({ url }: { readonly url: string }): React.JSX.Element | null => {
  const [failed, setFailed] = useState(false);
  return failed ? null : (
    <img
      src={`/api/images?url=${encodeURIComponent(url)}`}
      alt=""
      loading="lazy"
      decoding="async"
      className="size-16 shrink-0 rounded-lg object-cover"
      onError={() => {
        setFailed(true);
      }}
    />
  );
};

const WebLinkCardsContent = ({
  channelId,
  messageId,
  content,
  visible,
}: WebLinkCardsProps & {
  readonly visible: boolean;
}): React.JSX.Element | null => {
  const api = useApi();
  const { t } = useI18n();
  const links = webLinksOf(readBody(content).tree, window.location.origin);
  const answers = useQueries({
    queries: links.map((url) => ({
      queryKey: keys.webLinkPreview(channelId, messageId, url),
      queryFn: ({ signal }: { signal: AbortSignal }): Promise<WebLinkPreviewResponse> =>
        api.previewMessageLink(messageId, url, signal),
      enabled: visible,
      staleTime: (query: { state: { data: unknown } }): number =>
        query.state.data === null ? 60_000 : 300_000,
      retry: false,
    })),
  });
  const drawn = links.flatMap((url, index) => {
    const card = answers[index]?.data;
    return card === undefined || card === null ? [] : [{ url, card }];
  });
  if (drawn.length === 0) return null;
  return (
    <div className="mt-1 flex max-w-feed flex-col gap-2">
      {drawn.map(({ url, card }) => (
        <article
          key={url}
          data-web-link-card=""
          className="min-w-0 rounded-xl border-hairline border-border-subtle bg-surface-100 shadow-card"
        >
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex min-w-0 items-start gap-3 rounded-xl px-3 py-2 text-ink focus-visible:-outline-offset-focus"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="break-all font-mono text-caption text-ink-muted">
                {new URL(url).hostname}
              </span>
              <span className="line-clamp-2 break-words text-body font-medium group-hover:underline">
                {card.title}
              </span>
              {card.description !== null && (
                <span className="line-clamp-2 break-words text-label text-ink-muted">
                  {card.description}
                </span>
              )}
              <VisuallyHidden>{t('message.link.external')}</VisuallyHidden>
            </span>
            {card.imageUrl !== null && <Cover key={card.imageUrl} url={card.imageUrl} />}
          </a>
        </article>
      ))}
    </div>
  );
};

export default WebLinkCardsContent;
