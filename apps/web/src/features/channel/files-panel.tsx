/**
 * A channel's files, in the panel beside its conversation (D-129, `UX.md` §4.2).
 *
 * Every file of the channel's messages, newest message first, each with who shared it and when.
 * An image shows its thumbnail and opens the full image; anything else is a download, as it is in
 * the message (`messages/attachments.tsx`). A file shared in a thread opens that thread here, in
 * the panel's place.
 *
 * The list is read when the panel opens and again when a frame says it changed — a message with
 * files arriving, or one deleted (`realtime/engine.ts`); the states are the panel's own (§8):
 * loading, failed with Retry, and empty.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChannelFile } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannelFiles } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useThreads } from '../threads/thread-context';
import { useFeedPorts } from './feed-ports';
import { useSidePanel } from './side-panel';

export const FILES_PANEL_ID = 'channel-files';

const at = (file: ChannelFile): string => `/api/attachments/${file.attachment.id}`;

/** An image's thumbnail, or the file glyph when it is not an image or did not load. */
const Preview = ({ file }: { readonly file: ChannelFile }): React.JSX.Element => {
  const [failed, setFailed] = useState(false);
  if (file.attachment.kind !== 'image' || failed) {
    return (
      <span
        aria-hidden="true"
        className="inline-flex size-avatar-lg shrink-0 items-center justify-center rounded-md bg-surface-200 text-ink-muted"
      >
        <Icon name="file" />
      </span>
    );
  }
  return (
    <img
      src={`${at(file)}/thumbnail`}
      alt=""
      loading="lazy"
      className="size-avatar-lg shrink-0 rounded-md bg-surface-200 object-cover"
      onError={() => {
        setFailed(true);
      }}
    />
  );
};

const FileRow = ({
  file,
  now,
}: {
  readonly file: ChannelFile;
  readonly now: Date;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const threads = useThreads();
  const { attachment, sender } = file;
  const size = format.bytes(attachment.sizeBytes);
  const image = attachment.kind === 'image';
  const parentId = file.parentId;
  return (
    <li className="flex items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-200">
      <Preview file={file} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <a
          href={at(file)}
          {...(image
            ? { target: '_blank', rel: 'noopener noreferrer' }
            : { download: attachment.fileName })}
          aria-label={
            image
              ? t('attachment.open', { name: attachment.fileName })
              : t('attachment.download', { name: attachment.fileName, size })
          }
          className="truncate rounded-sm text-label font-medium text-ink hover:text-accent-text"
        >
          {attachment.fileName}
        </a>
        <span className="flex min-w-0 items-center gap-1 text-caption text-ink-muted">
          <Avatar name={sender.displayName} username={sender.username} size="sm" />
          <span className="truncate">{sender.displayName}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={file.sentAt} className="shrink-0 font-mono">
            {format.time(file.sentAt, now)}
          </time>
          <span aria-hidden="true">·</span>
          <span className="shrink-0 font-mono">{size}</span>
        </span>
        {parentId !== null && (
          <button
            type="button"
            className="self-start rounded-sm text-caption text-accent-text underline"
            onClick={() => {
              threads.open(parentId);
            }}
          >
            {t('files.inThread')}
          </button>
        )}
      </div>
    </li>
  );
};

const FilesPanelView = ({
  channelId,
  channelLabel,
}: {
  readonly channelId: string;
  readonly channelLabel: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { close } = useSidePanel();
  const query = useChannelFiles(channelId);
  const now = useFeedPorts().clock.now();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const files = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data]);

  // Focus moves in as the panel opens (`UX.md` §7).
  useEffect(() => {
    heading.current?.focus();
  }, []);

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus label={t('files.loading')} className="flex flex-col gap-3 p-4">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="size-avatar-lg" />
            <Skeleton className="w-members" />
          </div>
        ))}
      </LoadingStatus>
    );
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title={t('files.error.title')}
        body={t('files.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (files.length === 0) {
    body = (
      <section className="flex flex-col items-center gap-3 px-4 py-8 text-center">
        <span
          aria-hidden="true"
          className="inline-flex size-avatar-lg items-center justify-center rounded-lg bg-accent-subtle text-accent-text"
        >
          <Icon name="file" size="lg" />
        </span>
        <h3 className="text-title text-ink">{t('files.empty.title')}</h3>
        <p className="text-body text-ink-muted">{t('files.empty.body')}</p>
      </section>
    );
  } else {
    body = (
      <div className="flex flex-col gap-3 px-2 py-2">
        <ul aria-labelledby={headingId} className="flex flex-col gap-1">
          {files.map((file) => (
            <FileRow key={file.attachment.id} file={file} now={now} />
          ))}
        </ul>
        {query.isFetchNextPageError && (
          <p role="alert" className="flex items-center gap-2 px-2 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            {t('files.moreFailed')}
          </p>
        )}
        {query.hasNextPage && (
          <div className="px-2">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('files.more')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <aside
      id={FILES_PANEL_ID}
      aria-labelledby={headingId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
      className="flex w-thread shrink-0 flex-col border-l-hairline border-border-subtle bg-surface-100 max-narrow:absolute max-narrow:inset-0 max-narrow:z-sticky max-narrow:w-full"
    >
      <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b-hairline border-border-subtle px-4">
        <h2
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="min-w-0 truncate text-title font-semibold text-ink"
        >
          {t('files.title')}{' '}
          <span className="font-normal text-ink-muted">{`· ${channelLabel}`}</span>
        </h2>
        <IconButton label={t('files.close')} glyph="close" shortcut="Esc" onClick={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </aside>
  );
};

/** The channel's files panel, when it is the one open. */
export const FilesPanel = (props: {
  readonly channelId: string;
  readonly channelLabel: string;
}): React.JSX.Element | null => {
  const { panel } = useSidePanel();
  return panel === 'files' ? <FilesPanelView {...props} /> : null;
};
