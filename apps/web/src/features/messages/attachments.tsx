/**
 * What a message carries, drawn under its words (D-109 §6).
 *
 * - **An image** is its thumbnail, in a box shaped like the image and kept before it loads, so a
 *   picture arriving never moves what someone is reading (`UX.md` §6). The box is at most
 *   `size-attachment` on its longer side and never larger than the image; it opens the full image.
 * - **A file** is its name and size, and a download. The API serves it as one whatever it claims to
 *   be (#111), so here it is only a link.
 * - A thumbnail that does not load says so in its own box, with Retry (`UX.md` §8).
 * - Each is a card inside the message: a hairline and a one-pixel shadow (D-110 §2); a size is
 *   machine text, so it is mono (§1).
 *
 * The bytes are the API's (`/api/attachments/:id`), read with the session like everything else:
 * never a public URL.
 */
import { useState } from 'react';
import type { Attachment } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';

const at = (attachment: Attachment): string => `/api/attachments/${attachment.id}`;

const ImageAttachment = ({
  attachment,
  width,
  height,
}: {
  readonly attachment: Attachment;
  readonly width: number;
  readonly height: number;
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
      className="block rounded-xl"
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

const FileAttachment = ({ attachment }: { readonly attachment: Attachment }): React.JSX.Element => {
  const { t, format } = useI18n();
  const size = format.bytes(attachment.sizeBytes);
  return (
    <a
      href={at(attachment)}
      download={attachment.fileName}
      aria-label={t('attachment.download', { name: attachment.fileName, size })}
      className="flex items-center gap-2 rounded-xl border-hairline border-border-subtle bg-surface-100 px-3 py-2 text-label text-ink shadow-card"
    >
      <Icon name="file" size="sm" />
      <span className="min-w-0 truncate">{attachment.fileName}</span>
      <span className="font-mono text-caption text-ink-muted">{size}</span>
    </a>
  );
};

/** A message's attachments, in the order they were uploaded; nothing when it has none. */
export const Attachments = ({
  attachments,
}: {
  readonly attachments: readonly Attachment[];
}): React.JSX.Element | null => {
  const { t } = useI18n();
  if (attachments.length === 0) return null;
  return (
    <ul aria-label={t('attachment.list')} className="mt-1 flex flex-wrap items-start gap-2">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="min-w-0 max-w-full">
          {attachment.kind === 'image' &&
          attachment.width !== null &&
          attachment.height !== null ? (
            <ImageAttachment
              attachment={attachment}
              width={attachment.width}
              height={attachment.height}
            />
          ) : (
            <FileAttachment attachment={attachment} />
          )}
        </li>
      ))}
    </ul>
  );
};
