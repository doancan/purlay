/**
 * The files a message will carry, uploaded the moment they are added (D-109 §3, #370).
 *
 * Each is uploaded at once under an id chosen here (a UUIDv7), so Retry asks for the same upload
 * and a retry of one that did land is answered with it. A file over the limit is refused here,
 * before a byte leaves (the server would say the same at the edge); anything else the server
 * refuses is `failed`, with its reason and Retry — never dropped. A removed file is thrown away on
 * the server too, or the person is told it was not.
 */
import { useCallback, useContext, useState } from 'react';
import {
  ATTACHMENT_BYTES_MAX,
  ATTACHMENTS_PER_MESSAGE_MAX,
  messageId,
  type Attachment,
} from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { codeOf, useDescribeFailure, type FailureCode } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { systemClock } from '../../system-clock';
import { IconButton } from '../../ui/icon-button';
import { useToast } from '../../ui/toast';
import { useWorkspace } from '../shell/workspace';

type Upload = { readonly id: string; readonly name: string; readonly file: Blob } &
  /** How much has been sent, as a whole percent; null until the browser has measured any (#388). */
  (
    | { readonly status: 'uploading'; readonly percent: number | null }
    | { readonly status: 'ready'; readonly attachment: Attachment }
    | { readonly status: 'failed'; readonly reason: FailureCode }
    /** Over the limit: refused here, so there is nothing to retry. */
    | { readonly status: 'too-large' }
  );

export interface Uploads {
  readonly items: readonly Upload[];
  readonly add: (files: readonly File[]) => void;
  readonly retry: (id: string) => void;
  readonly remove: (id: string) => void;
  /** What was sent goes with it. */
  readonly clear: () => void;
}

export const useUploads = (): Uploads => {
  const api = useApi();
  const { workspace } = useWorkspace();
  const { show } = useToast();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const clock = useContext(RealtimePortsContext).clock ?? systemClock;
  const [items, setItems] = useState<readonly Upload[]>([]);

  const settle = useCallback((id: string, next: Upload): void => {
    setItems((all) => all.map((item) => (item.id === id ? next : item)));
  }, []);

  const start = useCallback(
    (item: { readonly id: string; readonly name: string; readonly file: Blob }): void => {
      // Told on every chunk; kept only when the whole percent moves, so a fast link is not a re-render a chunk.
      const progress = (fraction: number): void => {
        const percent = Math.floor(fraction * 100);
        setItems((all) =>
          all.map((candidate) =>
            candidate.id === item.id &&
            candidate.status === 'uploading' &&
            candidate.percent !== percent
              ? { ...candidate, percent }
              : candidate,
          ),
        );
      };
      api.upload(workspace.id, item, progress).then(
        (attachment) => {
          settle(item.id, { ...item, status: 'ready', attachment });
        },
        (failure: unknown) => {
          settle(item.id, { ...item, status: 'failed', reason: codeOf(failure) });
        },
      );
    },
    [api, settle, workspace.id],
  );

  const add = (files: readonly File[]): void => {
    const room = ATTACHMENTS_PER_MESSAGE_MAX - items.length;
    if (files.length > room) {
      show({ message: t('composer.tooManyFiles', { count: ATTACHMENTS_PER_MESSAGE_MAX }) });
    }
    const added: Upload[] = files.slice(0, Math.max(room, 0)).map((file) => {
      const base = { id: messageId(clock.now()), name: file.name, file };
      return file.size > ATTACHMENT_BYTES_MAX
        ? { ...base, status: 'too-large' }
        : { ...base, status: 'uploading', percent: null };
    });
    setItems((all) => [...all, ...added]);
    for (const item of added) if (item.status === 'uploading') start(item);
  };

  const retry = (id: string): void => {
    const item = items.find((candidate) => candidate.id === id);
    if (item?.status !== 'failed') return;
    const again = { id: item.id, name: item.name, file: item.file };
    settle(id, { ...again, status: 'uploading', percent: null });
    start(again);
  };

  const remove = (id: string): void => {
    const item = items.find((candidate) => candidate.id === id);
    setItems((all) => all.filter((candidate) => candidate.id !== id));
    // Only an upload that landed is on the server; one in flight is let go, and left to the sweep.
    if (item?.status === 'ready') {
      api.discardAttachment(id).catch((failure: unknown) => {
        show({ message: `${t('upload.discardFailed', { name: item.name })} ${describe(failure)}` });
      });
    }
  };

  return {
    items,
    add,
    retry,
    remove,
    clear: (): void => {
      setItems([]);
    },
  };
};

/** The files beside the words: each one's name and state, Retry when it failed, and Remove. */
export const UploadList = ({
  uploads,
}: {
  readonly uploads: Uploads;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  if (uploads.items.length === 0) return null;
  return (
    <ul aria-label={t('composer.files')} className="flex flex-wrap gap-2 px-4 pt-2">
      {uploads.items.map((item) => (
        <li
          key={item.id}
          className="flex min-w-0 items-center gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 py-1 pl-2 pr-1 text-label text-ink"
        >
          <Icon name={item.status === 'uploading' ? 'sending' : 'file'} size="sm" />
          <span className="min-w-0 truncate">{item.name}</span>
          <span
            className={
              item.status === 'failed' || item.status === 'too-large'
                ? 'text-caption text-danger-text'
                : 'text-caption text-ink-muted'
            }
            {...(item.status === 'uploading' && item.percent !== null
              ? {
                  role: 'progressbar',
                  'aria-label': t('upload.progressOf', { name: item.name }),
                  'aria-valuemin': 0,
                  'aria-valuemax': 100,
                  'aria-valuenow': item.percent,
                }
              : {})}
          >
            {item.status === 'uploading'
              ? item.percent === null
                ? t('upload.uploading')
                : t('upload.uploadingPercent', { percent: item.percent })
              : item.status === 'failed'
                ? t('upload.failed')
                : item.status === 'too-large'
                  ? t('upload.tooLarge', { size: format.bytes(ATTACHMENT_BYTES_MAX) })
                  : format.bytes(item.attachment.sizeBytes)}
          </span>
          {item.status === 'failed' && (
            <button
              type="button"
              aria-label={t('upload.retry', { name: item.name })}
              className="text-caption underline"
              onClick={() => {
                uploads.retry(item.id);
              }}
            >
              {t('common.retry')}
            </button>
          )}
          <IconButton
            label={t('upload.remove', { name: item.name })}
            glyph="close"
            onClick={() => {
              uploads.remove(item.id);
            }}
          />
        </li>
      ))}
    </ul>
  );
};
