/**
 * The door to the image viewer (D-159): what the feed and the files panel hold, so the viewer itself
 * stays in the deferred chunk (`app/deferred.ts`), fetched the first time somebody opens a picture
 * (or points at one, so it is usually there by the click) and costing the first page only this.
 *
 * A viewer that does not arrive says so in a toast and nothing opens; the click can be made again,
 * and the import is asked for again then, not remembered as failed.
 */
import { useCallback, useState } from 'react';
import type { Attachment } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { useToast } from '../../ui/toast';
import type * as Deferred from '../../app/deferred';

/** One picture the viewer can show: the file, who shared it and when. */
export interface ViewedImage {
  readonly attachment: Attachment;
  readonly sharedBy: string;
  /** ISO timestamp of the message that carries it. */
  readonly sharedAt: string;
}

let loading: Promise<typeof Deferred> | null = null;

const load = (): Promise<typeof Deferred> => {
  loading ??= import('../../app/deferred').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
};

interface Open {
  readonly images: readonly ViewedImage[];
  readonly index: number;
  readonly opener: HTMLElement | null;
  readonly View: typeof Deferred.ImageViewer;
}

export interface ImageViewerDoor {
  /** Opens the viewer on `images[index]`; focus goes back to `opener` when it closes. */
  readonly open: (
    images: readonly ViewedImage[],
    index: number,
    opener: HTMLElement | null,
  ) => void;
  /** Fetches the viewer's chunk ahead of a click, when a picture is pointed at or focused. */
  readonly preload: () => void;
  /** The viewer while it is open, to be drawn anywhere: it is a portal. */
  readonly viewer: React.ReactNode;
}

export const useImageViewer = (): ImageViewerDoor => {
  const { t } = useI18n();
  const { show } = useToast();
  const [state, setState] = useState<Open | null>(null);

  const open = useCallback(
    (images: readonly ViewedImage[], index: number, opener: HTMLElement | null): void => {
      load().then(
        (module) => {
          setState({ images, index, opener, View: module.ImageViewer });
        },
        () => {
          show({ message: t('viewer.unavailable') });
        },
      );
    },
    [show, t],
  );

  const preload = useCallback((): void => {
    // A preload that fails is told by the click that follows it, not twice.
    load().catch(() => undefined);
  }, []);

  const viewer =
    state === null ? null : (
      <state.View
        images={state.images}
        index={state.index}
        returnFocusTo={state.opener}
        onIndexChange={(index) => {
          setState((current) => (current === null ? null : { ...current, index }));
        }}
        onClose={() => {
          setState(null);
        }}
      />
    );

  return { open, preload, viewer };
};

/**
 * A click that is the viewer's: the main button with no key held. A click with ⌘, Ctrl, Shift or the
 * middle button is the browser's — a new tab, a new window — and the link under it still goes there.
 */
export const isPlainClick = (event: React.MouseEvent): boolean =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
