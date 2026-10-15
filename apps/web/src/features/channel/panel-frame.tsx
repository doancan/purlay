/**
 * The frame every panel beside the conversation shares, other than a thread (D-129, D-130): a
 * labelled complementary region the thread's width, covering the conversation on a narrow window,
 * with a heading that names it and its channel, a close control, and Esc.
 *
 * **Focus is the panel's** (`UX.md` §7): it moves to the heading as the panel opens, and comes back
 * there when a control that answered by going away — the last Load more, a Retry that worked —
 * would otherwise leave it on nothing, and Esc with it.
 */
import { useEffect, useId, useRef } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { IconButton } from '../../ui/icon-button';
import { GlyphEmptyState } from '../../ui/states';
import { useSidePanel } from './side-panel';

export interface PanelFocus {
  readonly panelRef: React.RefObject<HTMLElement | null>;
  readonly headingRef: React.RefObject<HTMLHeadingElement | null>;
  readonly headingId: string;
  /** Called as a control asks for an answer that may take it away. */
  readonly answering: () => void;
}

/**
 * The panel's focus, given whether a read is on its way and when the last answer landed: an answer
 * that comes at once is drawn in one render with the start of its read, so its time says there is
 * one where the read's state alone would not.
 */
export const usePanelFocus = (fetching: boolean, landed: number): PanelFocus => {
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const waiting = useRef(false);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!waiting.current || fetching) return;
    waiting.current = false;
    if (!(panelRef.current?.contains(document.activeElement) ?? false)) {
      headingRef.current?.focus();
    }
  }, [fetching, landed]);

  return {
    panelRef,
    headingRef,
    headingId,
    answering: (): void => {
      waiting.current = true;
    },
  };
};

export const PanelFrame = ({
  id,
  title,
  channelLabel,
  closeLabel,
  focus,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly channelLabel: string;
  readonly closeLabel: string;
  readonly focus: PanelFocus;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { close } = useSidePanel();
  return (
    <aside
      ref={focus.panelRef}
      id={id}
      aria-labelledby={focus.headingId}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
      className="flex w-thread shrink-0 flex-col border-l-hairline border-border-subtle bg-surface-100 max-narrow:absolute max-narrow:inset-0 max-narrow:z-sticky max-narrow:w-full"
    >
      <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b-hairline border-border-subtle px-4">
        <h2
          ref={focus.headingRef}
          id={focus.headingId}
          tabIndex={-1}
          className="min-w-0 truncate text-title font-semibold text-ink"
        >
          {title} <span className="font-normal text-ink-muted">{`· ${channelLabel}`}</span>
        </h2>
        <IconButton label={closeLabel} glyph="close" shortcut="Esc" onClick={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
};

/** A panel with nothing in it yet: what it is for, and how something gets here. */
export const PanelEmpty = ({
  glyph,
  title,
  body,
}: {
  readonly glyph: GlyphName;
  readonly title: string;
  readonly body: string;
}): React.JSX.Element => (
  <GlyphEmptyState glyph={glyph} tone="accent" title={title} body={body} as="h3" />
);

/**
 * A list that is shown but could not be brought up to date: said above it, with Retry — whether it
 * holds something or nothing, since an empty list may be the one that is behind.
 */
export const StaleBanner = ({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <p role="alert" className="flex items-center gap-2 px-4 pt-3 text-label text-danger-text">
      <Icon name="failed" size="sm" />
      {message}
      <span aria-hidden="true">·</span>
      <button type="button" className="underline" onClick={onRetry}>
        {t('common.retry')}
      </button>
    </p>
  );
};
