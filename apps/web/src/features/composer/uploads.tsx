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
  ATTACHMENT_PIXELS_MAX,
  ATTACHMENT_SIDE_MAX,
  ATTACHMENTS_PER_MESSAGE_MAX,
  messageId,
  type Attachment,
} from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { codeOf, useDescribeFailure, type FailureCode } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import type { Formatters } from '../../i18n/format';
import type { Translate } from '../../i18n/types';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { systemClock } from '../../system-clock';
import { IconButton } from '../../ui/icon-button';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useWorkspace } from '../shell/workspace';

type Upload = { readonly id: string; readonly name: string; readonly file: Blob } &
  /** How much has been sent, as a whole percent; null until the browser has measured any (#388). */
  (
    | { readonly status: 'uploading'; readonly percent: number | null }
    | { readonly status: 'ready'; readonly attachment: Attachment }
    | {
        readonly status: 'failed';
        readonly reason: FailureCode;
        /** The room the workspace still had, when it was out of room (D-159). */
        readonly remainingBytes: number | null;
      }
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
          settle(item.id, {
            ...item,
            status: 'failed',
            reason: codeOf(failure),
            remainingBytes: isApiError(failure) ? failure.remainingBytes : null,
          });
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

/**
 * Why an upload was refused, in words, from the code it was refused with (D-159) — and whether Retry
 * is offered: not where the same bytes would be refused the same way (too large, unreadable, a type
 * refused, a workspace the person is no longer in), so the one control left is Remove. Out of room
 * says how much room there is, so the person knows what would still go. The general sentences of
 * `failure.ts` are written for a dialog; these are a chip's, a phrase beside a file's name.
 */
const uploadRefusal = (
  reason: FailureCode,
  remainingBytes: number | null,
  t: Translate,
  format: Formatters,
): { readonly text: string; readonly retry: boolean } => {
  switch (reason) {
    case 'PAYLOAD_TOO_LARGE':
      return {
        text: t('upload.tooLarge', { size: format.bytes(ATTACHMENT_BYTES_MAX) }),
        retry: false,
      };
    case 'IMAGE_TOO_LARGE':
      return {
        text: t('upload.why.imageTooLarge', {
          side: format.number(ATTACHMENT_SIDE_MAX),
          megapixels: format.number(ATTACHMENT_PIXELS_MAX / 1_000_000),
        }),
        retry: false,
      };
    case 'IMAGE_UNREADABLE':
      return { text: t('upload.why.unreadable'), retry: false };
    case 'UNSUPPORTED_MEDIA_TYPE':
      return { text: t('upload.why.type'), retry: false };
    case 'STORAGE_QUOTA_EXCEEDED':
      return {
        text:
          remainingBytes === null || remainingBytes === 0
            ? t('upload.why.quotaNone')
            : t('upload.why.quota', { size: format.bytes(remainingBytes) }),
        retry: true,
      };
    case 'TOO_MANY_PENDING_UPLOADS':
      return { text: t('upload.why.pending'), retry: true };
    case 'NETWORK':
    case 'TIMEOUT':
      return { text: t('upload.why.network'), retry: true };
    case 'RATE_LIMITED':
      return { text: t('upload.why.busy'), retry: true };
    case 'STORAGE_UNAVAILABLE':
      return { text: t('upload.why.storage'), retry: true };
    case 'UNAUTHENTICATED':
      return { text: t('upload.why.session'), retry: true };
    // The workspace answers a person who is no longer in it as one that does not exist (404, never
    // 403): taken out of it, or it was deleted. The same bytes would be refused the same way.
    case 'WORKSPACE_NOT_FOUND':
      return { text: t('upload.why.notInWorkspace'), retry: false };
    // Nothing more to say than that it did not: the server's fault, or a refusal no upload meets.
    case 'LENGTH_REQUIRED':
    case 'ATTACHMENT_ID_CONFLICT':
    case 'ATTACHMENT_NOT_FOUND':
    case 'FORBIDDEN':
    // Membership is the send's to judge (D-156): an upload is the workspace's, before any channel.
    case 'NOT_A_CHANNEL_MEMBER':
    case 'DATABASE_UNAVAILABLE':
    case 'INTERNAL':
    case 'MALFORMED':
    case 'UNKNOWN':
    case 'ACCOUNT_EMAIL_CONFLICT':
    case 'CHANNEL_NAME_TAKEN':
    case 'CHANNEL_NOT_FOUND':
    case 'EMAIL_REQUIRED':
    case 'EMAIL_SIGN_IN_UNAVAILABLE':
    case 'EXPORT_IN_PROGRESS':
    case 'EXPORT_NOT_FOUND':
    case 'GITHUB_FEED_EXISTS':
    case 'GITHUB_FEED_NOT_FOUND':
    case 'GITHUB_FEEDS_LIMIT':
    case 'GITHUB_REPOSITORY_MISMATCH':
    case 'IMAGE_NOT_AVAILABLE':
    case 'INCIDENT_ID_CONFLICT':
    case 'INCIDENT_NOT_FOUND':
    case 'INCIDENT_OPEN':
    case 'INCIDENT_POSTMORTEM_CHANGED':
    case 'INCIDENT_RESOLVED':
    case 'INCIDENT_RESPONDERS_LIMIT':
    case 'INVALID_MESSAGE_ID':
    case 'INVITATION_NOT_FOUND':
    case 'LAST_CHANNEL_MEMBER':
    case 'LAST_OWNER':
    case 'MESSAGE_ID_CONFLICT':
    case 'MESSAGE_NOT_FOUND':
    case 'MESSAGE_VERSION_NOT_FOUND':
    case 'OAUTH_STATE_INVALID':
    case 'PINS_LIMIT':
    case 'PUSH_UNAVAILABLE':
    case 'REAUTHENTICATION_REQUIRED':
    case 'ROUTE_NOT_FOUND':
    case 'SAVED_LIMIT':
    case 'SIGN_IN_LINK_NOT_FOUND':
    case 'THREAD_NOT_RESOLVABLE':
    case 'USER_NOT_FOUND':
    case 'VALIDATION_FAILED':
    case 'WEBHOOK_SIGNATURE_INVALID':
    case 'WORKSPACE_SLUG_TAKEN':
      return { text: t('upload.failed'), retry: true };
  }
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
      {uploads.items.map((item) => {
        const refused =
          item.status === 'failed'
            ? uploadRefusal(item.reason, item.remainingBytes, t, format)
            : item.status === 'too-large'
              ? // Refused here, before a byte left, in the words the server would have used.
                uploadRefusal('PAYLOAD_TOO_LARGE', null, t, format)
              : null;
        return (
          <li
            key={item.id}
            className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 py-1 pl-2 pr-1 text-label text-ink"
          >
            <span className={refused === null ? 'inline-flex' : 'inline-flex text-danger-text'}>
              <Icon
                name={
                  item.status === 'uploading' ? 'sending' : refused === null ? 'file' : 'failed'
                }
                size="sm"
              />
            </span>
            {/* A refusal is said under the name, whole: a reason cut short says nothing. */}
            <span
              className={
                refused === null ? 'flex min-w-0 items-center gap-2' : 'flex min-w-0 flex-col'
              }
            >
              <span className="min-w-0 truncate">{item.name}</span>
              <span
                className={
                  refused === null
                    ? 'shrink-0 text-caption text-ink-muted'
                    : 'text-caption text-danger-text'
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
                {refused !== null ? (
                  <>
                    {/* The reason alone ("No connection") is said after what happened. */}
                    {refused.text !== t('upload.failed') && (
                      <VisuallyHidden>{`${t('upload.failed')}: `}</VisuallyHidden>
                    )}
                    <span>{refused.text}</span>
                  </>
                ) : item.status === 'uploading' ? (
                  item.percent === null ? (
                    t('upload.uploading')
                  ) : (
                    t('upload.uploadingPercent', { percent: item.percent })
                  )
                ) : item.status === 'ready' ? (
                  format.bytes(item.attachment.sizeBytes)
                ) : null}
              </span>
            </span>
            {refused?.retry === true && (
              <button
                type="button"
                aria-label={t('upload.retry', { name: item.name })}
                className="shrink-0 rounded-sm text-caption text-ink underline"
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
        );
      })}
    </ul>
  );
};
