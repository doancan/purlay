/**
 * The stream itself, and the keyboard that moves through it (`UX.md` §3).
 *
 * **Keyboard**: the feed is one Tab stop — one row is in the tab order (roving focus), and the
 * controls inside a message are stops only while focus is in its row (`row-stops.ts`, D-168) —
 * and ↑ ↓ Home End move between rows (`row-keys.ts`); Escape returns to the composer — or, on the root whose thread is open in
 * the panel, closes the panel first (`features/threads`, which also owns T, R and ⌘⇧R on the
 * focused row). Visible focus is the global ring, which a row never hides.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { useThreads } from '../threads/thread-context';
import { ThreadedMessageRow } from '../threads/threaded-row';
import { useEditing } from '../messages/editing';
import { handleRowKeys } from '../messages/row-keys';
import type { FeedItem } from './feed-model';

/**
 * The channel's composer, wherever the screen put it: the text box in this region that is for
 * writing *to the channel*. The thread panel has a reply box of its own in the same region, and Esc
 * "to the composer" must not land in it (found in a browser, when threads were inline: with a
 * thread open, Esc moved focus into its reply box).
 */
const composerIn = (region: Element | null): HTMLElement | null => {
  const outsideThreads = (candidates: Iterable<HTMLElement>): HTMLElement | undefined =>
    Array.from(candidates).find((box) => box.closest('[data-thread-root]') === null);
  return (
    outsideThreads(region?.querySelectorAll<HTMLElement>('[data-composer]') ?? []) ??
    outsideThreads(region?.querySelectorAll<HTMLElement>('textarea') ?? []) ??
    null
  );
};

interface FeedListProps {
  readonly content: React.RefObject<HTMLDivElement | null>;
  readonly scroller: React.RefObject<HTMLDivElement | null>;
  readonly items: readonly FeedItem[];
  readonly ariaLabel: string;
  readonly busy: boolean;
  readonly meId: string;
  readonly nowMinute: number;
  readonly members: ReadonlyMap<string, string>;
  /** The one row in the tab order. */
  readonly tabbable: string | null;
  /** The message a link opened, marked for a moment (D-149). */
  readonly landed: string | null;
  readonly onRetry: (id: string) => void;
  readonly onDiscard: (id: string) => void;
  readonly onFocusRow: (id: string) => void;
}

/**
 * The stream itself, and the keyboard that moves through it. It asks the threads' slice first
 * what a key means (T, R, ⌘⇧R, and Escape on the root whose thread is open) before the feed's own
 * keys get it.
 */
export const FeedList = ({
  content,
  scroller,
  items,
  ariaLabel,
  busy,
  meId,
  nowMinute,
  members,
  tabbable,
  landed,
  onRetry,
  onDiscard,
  onFocusRow,
}: FeedListProps): React.JSX.Element => {
  const { t } = useI18n();
  const threads = useThreads();

  const rows = (): HTMLElement[] =>
    Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-message-row]') ?? []);

  const editing = useEditing();
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Menus and their items render in a portal but bubble here through React; they are not ours.
    if (event.defaultPrevented || !scroller.current?.contains(event.target as Node)) return;
    if (threads.handleKey(event)) return;
    if (event.key === 'Escape') {
      composerIn(scroller.current.closest('main'))?.focus();
      return;
    }
    handleRowKeys(event, rows(), editing.start);
  };

  const onFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-message-id]')?.dataset[
      'messageId'
    ];
    if (id !== undefined) onFocusRow(id);
  };

  return (
    /* A feed is an ordered stream of articles, and a screen reader needs to know it is one. */
    <div
      ref={content}
      role="feed"
      className="w-full px-6 max-narrow:px-4"
      aria-label={ariaLabel}
      aria-busy={busy}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocus}
    >
      {items.map((item) => {
        if (item.kind === 'day') {
          return (
            <div
              key={item.key}
              aria-hidden="true"
              className="flex items-center py-6 text-caption font-medium uppercase text-ink-muted"
            >
              <span className="flex-1 border-t-hairline border-border-subtle" />
              <span className="shrink-0 px-3">{item.label}</span>
              <span className="flex-1 border-t-hairline border-border-subtle" />
            </div>
          );
        }
        if (item.kind === 'marker') {
          return (
            <div
              key={item.key}
              data-feed-marker=""
              className="flex items-center gap-3 py-3 text-caption font-semibold text-danger-text"
            >
              <span className="flex-1 border-t-hairline border-danger" />
              <span className="shrink-0">{t('message.newMarker')}</span>
            </div>
          );
        }
        return (
          <ThreadedMessageRow
            key={item.key}
            message={item.message}
            delivery={item.delivery}
            failure={item.failure}
            grouped={item.grouped}
            meId={meId}
            nowMinute={nowMinute}
            members={members}
            tabIndex={item.key === tabbable ? 0 : -1}
            landed={item.key === landed}
            onRetry={onRetry}
            onDiscard={onDiscard}
          />
        );
      })}
    </div>
  );
};
