/** Read the shared item here; return to its exact conversation for the surrounding discussion. */
import { useState } from 'react';
import type { Channel, SharedItem, SharedFileItem } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { nameOf } from '../../../lib/author';
import { messageHref } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { ListCard, listRowClasses } from '../../../ui/list-column';
import { cn } from '../../../ui/cn';
import { useWorkspace } from '../../shell/workspace';
import { useChannelTitle } from '../channel/channel-header';
import { FileAttachment } from '../messages/attachments';
import { isPlainClick, useImageViewer } from '../messages/image-viewer-door';

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => (
  <span>{useChannelTitle(channel)}</span>
);

const ImageLink = ({
  file,
  onOpen,
  onPreload,
}: {
  readonly file: SharedFileItem;
  readonly onOpen: (opener: HTMLElement) => void;
  readonly onPreload: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  return (
    <a
      href={`/api/attachments/${file.attachment.id}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('attachment.open', { name: file.attachment.fileName })}
      aria-haspopup="dialog"
      className="flex min-w-0 items-center gap-3 rounded-md py-1 text-label text-ink hover:text-accent-text"
      onPointerEnter={onPreload}
      onFocus={onPreload}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(event.currentTarget);
      }}
    >
      {failed ? (
        <Icon name="file" />
      ) : (
        <img
          src={`/api/attachments/${file.attachment.id}/thumbnail`}
          alt=""
          loading="lazy"
          className="size-avatar-lg shrink-0 rounded-md bg-surface-200 object-cover"
          onError={() => {
            setFailed(true);
          }}
        />
      )}
      <span className="min-w-0 truncate font-medium">{file.attachment.fileName}</span>
    </a>
  );
};

export const SharedRows = ({
  items,
  channels,
}: {
  readonly items: readonly SharedItem[];
  readonly channels: readonly Channel[];
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const door = useImageViewer();
  const author = (item: SharedItem): string =>
    item.sender === null
      ? (item.sourceName ?? t('search.someone'))
      : nameOf(item.sender, t('user.erased'));
  const pictures = items.filter(
    (item): item is SharedFileItem => item.kind === 'file' && item.attachment.kind === 'image',
  );
  const images = pictures.map((item) => ({
    attachment: item.attachment,
    sharedBy: author(item),
    sharedAt: item.sentAt,
  }));
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  return (
    <>
      <ListCard label={t('shared.title')}>
        {items.map((item) => {
          const channel = byId.get(item.channelId);
          const key = `${item.messageId}:${item.kind === 'link' ? item.key : item.attachment.id}`;
          return (
            <li
              key={key}
              className={cn(
                listRowClasses,
                'flex min-w-0 flex-col gap-2 px-5 py-4 max-narrow:px-4',
              )}
            >
              {item.kind === 'link' ? (
                <div className="flex min-w-0 items-start gap-3">
                  <span className="mt-1 shrink-0 text-ink-muted">
                    <Icon name="link" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={item.link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block truncate rounded-sm text-label font-medium text-ink hover:text-accent-text"
                    >
                      {item.link.label}
                    </a>
                    <p className="truncate text-caption text-ink-muted" title={item.link.url}>
                      {item.link.url}
                    </p>
                  </div>
                </div>
              ) : item.attachment.kind === 'image' ? (
                <ImageLink
                  file={item}
                  onPreload={door.preload}
                  onOpen={(opener) => {
                    door.open(
                      images,
                      pictures.findIndex(
                        (picture) =>
                          picture.messageId === item.messageId &&
                          picture.attachment.id === item.attachment.id,
                      ),
                      opener,
                    );
                  }}
                />
              ) : (
                <FileAttachment attachment={item.attachment} />
              )}
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-muted">
                <span className="max-w-full truncate">{author(item)}</span>
                {channel !== undefined && (
                  <span className="max-w-full truncate">
                    <ChannelName channel={channel} />
                  </span>
                )}
                <time dateTime={item.sentAt} title={format.absolute(item.sentAt)}>
                  {format.date(item.sentAt)}
                </time>
                <a
                  href={messageHref(workspace.slug, item.channelId, item.messageId)}
                  className="ml-auto inline-flex min-h-control items-center gap-1 rounded-sm text-accent-text hover:underline max-narrow:min-h-touch"
                  onClick={(event) => {
                    if (isPlainClick(event)) {
                      event.preventDefault();
                      navigate(event.currentTarget.getAttribute('href') ?? '');
                    }
                  }}
                >
                  {t('shared.source')}
                  <Icon name="next" size="sm" />
                </a>
              </div>
            </li>
          );
        })}
      </ListCard>
      {door.viewer}
    </>
  );
};
