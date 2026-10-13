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
import { useMemo, useState } from 'react';
import type { ChannelFile } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannelFiles } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useThreads } from '../threads/thread-context';
import { useFeedPorts } from './feed-ports';
import { useNowMinute } from './now-minute';
import { PanelEmpty, PanelFrame, StaleBanner, usePanelFocus } from './panel-frame';
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
            aria-label={t('files.inThreadOf', { name: attachment.fileName })}
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
  const query = useChannelFiles(channelId);
  const now = new Date(useNowMinute(useFeedPorts()));
  const files = useMemo(() => query.data?.pages.flatMap((page) => page.data) ?? [], [query.data]);
  const focus = usePanelFocus(
    query.isFetching,
    Math.max(query.dataUpdatedAt, query.errorUpdatedAt),
  );
  const readAgain = (): void => {
    focus.answering();
    void query.refetch();
  };

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
        onRetry={readAgain}
      />
    );
  } else if (files.length === 0) {
    body = <PanelEmpty glyph="file" title={t('files.empty.title')} body={t('files.empty.body')} />;
  } else {
    body = (
      <div className="flex flex-col gap-3 px-2 py-2">
        <ul aria-labelledby={focus.headingId} className="flex flex-col gap-1">
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
                focus.answering();
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
    <PanelFrame
      id={FILES_PANEL_ID}
      title={t('files.title')}
      channelLabel={channelLabel}
      closeLabel={t('files.close')}
      focus={focus}
    >
      {query.isRefetchError && <StaleBanner message={t('files.staleFailed')} onRetry={readAgain} />}
      {body}
    </PanelFrame>
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
