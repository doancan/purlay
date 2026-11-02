/**
 * What a message carries, drawn under its words (D-109 §6).
 *
 * - **An image** is its thumbnail, in a box shaped like the image and kept before it loads, so a
 *   picture arriving never moves what someone is reading (`UX.md` §6). The box is at most
 *   `size-attachment` on its longer side and never larger than the image; it opens the image viewer
 *   on it, stepping through the message's pictures (D-159). It is still a link to the image, so a
 *   click with ⌘ or Ctrl, or the middle button, opens it in a tab as before.
 * - **A file** is its name and size, and a download. The API serves it as one whatever it claims to
 *   be (#111), so here it is a link — and, when it is text by its name and small (`attachment-preview.ts`),
 *   **Preview** beside it reads it in place, on request: a CSV as a table, Markdown formatted, code
 *   coloured, all through the renderer, so a file's words are never HTML (D-210).
 * - A thumbnail that does not load says so in its own box, with Retry (`UX.md` §8).
 * - Each is a card inside the message: a hairline and a one-pixel shadow (D-110 §2); a size is
 *   machine text, so it is mono (§1).
 *
 * The bytes are the API's (`/api/attachments/:id`), read with the session like everything else:
 * never a public URL.
 */
import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Attachment } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { renderContent } from '../content/render-content';
import { previewMarkdown, previewOf, type PreviewKind } from './attachment-preview';
import { isPlainClick, useImageViewer, type ViewedImage } from './image-viewer-door';

const at = (attachment: Attachment): string => `/api/attachments/${attachment.id}`;

const ImageAttachment = ({
  attachment,
  width,
  height,
  onOpen,
  onPreload,
}: {
  readonly attachment: Attachment;
  readonly width: number;
  readonly height: number;
  readonly onOpen: (opener: HTMLElement) => void;
  readonly onPreload: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  // Fitted inside the token's square, never past the image's own width, and shaped like it.
  const box = {
    width: `min(100%, ${String(width)}px, var(--size-attachment), calc(var(--size-attachment) * ${String(width)} / ${String(height)}))`,
    aspectRatio: `${String(width)} / ${String(height)}`,
  };
  if (failed) {
    return (
      <div
        style={box}
        className="flex flex-col items-center justify-center gap-1 rounded-xl border-hairline border-border-subtle bg-surface-100 p-2 text-label text-ink-muted shadow-card"
      >
        <Icon name="failed" size="sm" />
        <span>{t('attachment.failed')}</span>
        <button
          type="button"
          className="underline"
          onClick={() => {
            setFailed(false);
          }}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }
  return (
    <a
      href={at(attachment)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('attachment.open', { name: attachment.fileName })}
      aria-haspopup="dialog"
      // As wide as the picture, so the focus ring it gets back from the viewer is drawn around it.
      style={{ width: box.width }}
      className="block rounded-xl"
      onPointerEnter={onPreload}
      onFocus={onPreload}
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen(event.currentTarget);
      }}
    >
      <img
        src={`${at(attachment)}/thumbnail`}
        alt={attachment.fileName}
        loading="lazy"
        style={box}
        className="block rounded-xl border-hairline border-border-subtle bg-surface-200 object-cover shadow-card"
        onError={() => {
          setFailed(true);
        }}
      />
    </a>
  );
};

/** A file read in place: asked for once, kept, and drawn by the renderer in a box that scrolls. */
const FilePreview = ({
  id,
  attachment,
  preview,
}: {
  readonly id: string;
  readonly attachment: Attachment;
  readonly preview: PreviewKind;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const text = useQuery({
    queryKey: keys.attachmentText(attachment.id),
    queryFn: ({ signal }) => api.attachmentText(attachment.id, signal),
    // An attachment never changes: once read, it is the same words until the page goes.
    staleTime: Infinity,
  });
  const drawn = useMemo(
    () => (text.data === undefined ? null : previewMarkdown(preview, text.data)),
    [preview, text.data],
  );
  return (
    <section
      id={id}
      aria-label={t('attachment.preview.label', { name: attachment.fileName })}
      className="max-h-attachment-preview overflow-auto rounded-xl border-hairline border-border-subtle bg-surface-100 px-4 py-3 shadow-card scrollbar-thin"
    >
      {text.isPending ? (
        <LoadingStatus label={t('attachment.preview.loading')} className="flex flex-col gap-2">
          <Skeleton />
          <Skeleton className="w-members" />
        </LoadingStatus>
      ) : drawn === null ? (
        <ErrorState
          title={t('attachment.preview.failed')}
          body={t('attachment.preview.failedBody')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void text.refetch();
          }}
        />
      ) : (
        <>
          {renderContent(drawn.markdown)}
          {drawn.more !== null && (
            <p className="mt-2 text-caption text-ink-muted">
              {'rows' in drawn.more
                ? t('attachment.preview.rows', { count: drawn.more.rows })
                : t('attachment.preview.cut')}
            </p>
          )}
        </>
      )}
    </section>
  );
};

const FileAttachment = ({ attachment }: { readonly attachment: Attachment }): React.JSX.Element => {
  const { t, format } = useI18n();
  const size = format.bytes(attachment.sizeBytes);
  const preview = previewOf(attachment.fileName, attachment.sizeBytes);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const card = (
    <a
      href={at(attachment)}
      download={attachment.fileName}
      aria-label={t('attachment.download', { name: attachment.fileName, size })}
      className="flex min-w-0 items-center gap-2 rounded-xl border-hairline border-border-subtle bg-surface-100 px-3 py-2 text-label text-ink shadow-card"
    >
      <Icon name="file" size="sm" />
      <span className="min-w-0 truncate">{attachment.fileName}</span>
      <span className="font-mono text-caption text-ink-muted">{size}</span>
    </a>
  );
  if (preview === null) return card;
  const name = attachment.fileName;
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center gap-1">
        {card}
        <IconButton
          glyph="preview"
          label={t(open ? 'attachment.preview.hide' : 'attachment.preview.show', { name })}
          aria-expanded={open}
          aria-controls={panelId}
          className={open ? 'bg-surface-200 text-ink' : undefined}
          onClick={() => {
            setOpen(!open);
          }}
        />
      </div>
      {open && <FilePreview id={panelId} attachment={attachment} preview={preview} />}
    </div>
  );
};

/** Drawn as a picture: an image whose shape is known, so its box is kept before it loads. */
const isPicture = (
  attachment: Attachment,
): attachment is Attachment & { readonly width: number; readonly height: number } =>
  attachment.kind === 'image' && attachment.width !== null && attachment.height !== null;

/**
 * A message's attachments, in the order they were uploaded; nothing when it has none. Who sent the
 * message and when are the viewer's to say about each picture.
 */
export const Attachments = ({
  attachments,
  sharedBy,
  sharedAt,
}: {
  readonly attachments: readonly Attachment[];
  readonly sharedBy: string;
  readonly sharedAt: string;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const door = useImageViewer();
  if (attachments.length === 0) return null;
  const pictures: readonly ViewedImage[] = attachments
    .filter(isPicture)
    .map((attachment) => ({ attachment, sharedBy, sharedAt }));
  return (
    <ul aria-label={t('attachment.list')} className="mt-1 flex flex-wrap items-start gap-2">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="min-w-0 max-w-full">
          {isPicture(attachment) ? (
            <ImageAttachment
              attachment={attachment}
              width={attachment.width}
              height={attachment.height}
              onPreload={door.preload}
              onOpen={(opener) => {
                door.open(
                  pictures,
                  pictures.findIndex((picture) => picture.attachment.id === attachment.id),
                  opener,
                );
              }}
            />
          ) : (
            <FileAttachment attachment={attachment} />
          )}
        </li>
      ))}
      {door.viewer}
    </ul>
  );
};
