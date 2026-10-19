/**
 * The image viewer (D-159, `UX.md` §4.2): a picture over the whole window, fitted to it, with its
 * name, who shared it, when and its size, a download and the original in a new tab. Its own chunk,
 * opened through `image-viewer-door.tsx`.
 *
 * - **A Radix dialog**, so focus moves in and stays in, Esc closes it and the page behind is hidden
 *   from a screen reader. It is controlled and has no trigger, so focus is given back by hand to what
 *   opened it — a thumbnail — as `ui/dialog.tsx` does for the same reason.
 * - **On the navigation's tone** (D-118): dark in both themes, so a picture is judged against the same
 *   ground whatever the theme, and the chrome around it recedes.
 * - **Fitted, never cropped or enlarged.** The box is the image's own shape, at most its own size and
 *   at most the stage (container units), so it is reserved before the bytes arrive; the thumbnail the
 *   feed already loaded stands in it until the full image has.
 * - **←/→ step** through the pictures it was opened with — a message's, or the files panel's — and the
 *   controls for them keep their place when there is nothing that way, so the picture never moves.
 * - **A click beside the picture closes it**, as a click on a scrim does.
 */
import * as RadixDialog from '@radix-ui/react-dialog';
import { useState } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import { LoadingStatus } from '../../ui/skeleton';
import { Tooltip } from '../../ui/tooltip';
import type { ViewedImage } from './image-viewer-door';

const at = (image: ViewedImage): string => `/api/attachments/${image.attachment.id}`;

/** A link that looks like the header's icon buttons: Download and Open original are places, not actions. */
const linkClasses =
  'inline-flex h-control max-narrow:h-touch aspect-square shrink-0 items-center justify-center rounded-md text-nav-ink-muted transition-colors duration-hover ease-standard hover:bg-nav-hover hover:text-nav-ink';

const LinkControl = ({
  label,
  glyph,
  ...rest
}: {
  readonly label: string;
  readonly glyph: GlyphName;
  readonly href: string;
  readonly download?: string;
  readonly target?: string;
  readonly rel?: string;
}): React.JSX.Element => (
  <Tooltip content={label} side="bottom">
    <a {...rest} aria-label={label} className={linkClasses}>
      <Icon name={glyph} />
    </a>
  </Tooltip>
);

/** One picture, fitted to the stage; the thumbnail stands in while the full image loads. */
const Picture = ({ image }: { readonly image: ViewedImage }): React.JSX.Element => {
  const { t } = useI18n();
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  // A retry is a new element, so the browser asks again rather than remembering the failure.
  const [attempt, setAttempt] = useState(0);
  const { width, height, fileName } = image.attachment;
  const box =
    width === null || height === null
      ? undefined
      : {
          width: `min(100cqw, ${String(width)}px, calc(100cqh * ${String(width)} / ${String(height)}))`,
          aspectRatio: `${String(width)} / ${String(height)}`,
        };
  // Read here, not in a class position: the check reads a name a class uses as classes.
  const fitted = box !== undefined;
  if (state === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-col items-center gap-3 text-center text-label text-nav-ink-muted"
      >
        <Icon name="failed" size="lg" />
        <span>{t('attachment.failed')}</span>
        <button
          type="button"
          className="rounded-sm text-label text-nav-ink underline"
          onClick={() => {
            setState('loading');
            setAttempt((n) => n + 1);
          }}
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }
  return (
    <div
      style={box}
      className={fitted ? 'relative max-h-full max-w-full' : 'relative flex max-h-full max-w-full'}
    >
      {fitted && state === 'loading' && (
        <img
          src={`${at(image)}/thumbnail`}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 size-full rounded-md object-contain"
        />
      )}
      <img
        key={attempt}
        src={at(image)}
        alt={fileName}
        onLoad={() => {
          setState('ready');
        }}
        onError={() => {
          setState('failed');
        }}
        className={
          state === 'ready'
            ? 'relative block max-h-full max-w-full rounded-md object-contain size-full'
            : 'relative block max-h-full max-w-full rounded-md object-contain size-full opacity-0'
        }
      />
      {state === 'loading' && (
        <LoadingStatus label={t('viewer.loading')} className="absolute inset-0">
          {null}
        </LoadingStatus>
      )}
    </div>
  );
};

export interface ImageViewerProps {
  readonly images: readonly ViewedImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
  /** What opened it, given focus back on close. */
  readonly returnFocusTo: HTMLElement | null;
}

export const ImageViewer = ({
  images,
  index,
  onIndexChange,
  onClose,
  returnFocusTo,
}: ImageViewerProps): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const image = images[index];
  if (image === undefined) return null;
  const { attachment } = image;
  const previous = index > 0 ? index - 1 : null;
  const next = index < images.length - 1 ? index + 1 : null;

  const step = (to: number | null): void => {
    if (to !== null) onIndexChange(to);
  };

  /** A click on the stage itself, beside the picture, is a click on the backdrop. */
  const closeOnBackdrop = (event: React.MouseEvent): void => {
    if (event.target === event.currentTarget) onClose();
  };

  const stepper = (to: number | null, glyph: 'previous' | 'next'): React.JSX.Element => (
    // The slot is there either way, so the picture keeps its place at the first and the last.
    <div className="flex size-control max-narrow:size-touch shrink-0 items-center justify-center">
      {to !== null && (
        <IconButton
          size="nav"
          glyph={glyph}
          // On a ground of its own, so it is found against a dark picture as well as a light one.
          className="bg-nav-surface"
          label={t(glyph === 'previous' ? 'viewer.previous' : 'viewer.next')}
          shortcut={glyph === 'previous' ? '←' : '→'}
          onClick={() => {
            step(to);
          }}
        />
      )}
    </div>
  );

  return (
    <RadixDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-palette bg-nav-rail" />
        <RadixDialog.Content
          data-image-viewer=""
          className="fixed inset-0 z-palette flex flex-col bg-nav-rail text-nav-ink outline-none"
          onOpenAutoFocus={(event) => {
            // The viewer itself takes the first focus: a control taking it would show its tooltip, and
            // the tooltip would take the first Esc (#623). Tab still reaches every control.
            event.preventDefault();
            if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
          }}
          onCloseAutoFocus={(event) => {
            if (returnFocusTo?.isConnected !== true) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          onKeyDown={(event) => {
            // Esc is the viewer's, whatever has focus: a control's tooltip would otherwise take the
            // first one (Radix gives Escape to the topmost layer), and a picture is left in one key.
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              step(previous);
            } else if (event.key === 'ArrowRight') {
              event.preventDefault();
              step(next);
            }
          }}
        >
          <header className="flex h-header shrink-0 items-center gap-2 border-b-hairline border-nav-border px-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <RadixDialog.Title className="truncate text-label font-medium text-nav-ink">
                {attachment.fileName}
              </RadixDialog.Title>
              {/* One line, cut at its end on a narrow window: who first, the time last. */}
              <RadixDialog.Description className="truncate text-caption text-nav-ink-muted">
                {image.sharedBy}
                <span aria-hidden="true"> · </span>
                <span className="font-mono">{format.bytes(attachment.sizeBytes)}</span>
                <span aria-hidden="true"> · </span>
                <time dateTime={image.sharedAt} className="font-mono">
                  {format.absolute(image.sharedAt)}
                </time>
              </RadixDialog.Description>
            </div>
            <LinkControl
              label={t('viewer.download')}
              glyph="download"
              href={at(image)}
              download={attachment.fileName}
            />
            <LinkControl
              label={t('viewer.original')}
              glyph="external"
              href={at(image)}
              target="_blank"
              rel="noopener noreferrer"
            />
            <RadixDialog.Close asChild>
              <IconButton size="nav" glyph="close" label={t('viewer.close')} shortcut="Esc" />
            </RadixDialog.Close>
          </header>
          <div
            className="flex min-h-0 flex-1 items-center gap-2 px-4 py-6 max-narrow:px-2 max-narrow:py-4"
            onClick={closeOnBackdrop}
          >
            {stepper(previous, 'previous')}
            <div
              // Container units are what the picture is fitted against (`cqw`, `cqh`).
              className="flex size-full min-w-0 items-center justify-center @container-size"
              onClick={closeOnBackdrop}
            >
              <Picture key={attachment.id} image={image} />
            </div>
            {stepper(next, 'next')}
          </div>
          <footer className="flex h-control shrink-0 items-center justify-center pb-4 font-mono text-caption text-nav-ink-muted">
            {images.length > 1
              ? t('viewer.position', { index: index + 1, count: images.length })
              : null}
          </footer>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
