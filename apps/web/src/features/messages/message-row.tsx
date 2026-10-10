/**
 * One message, the way the approved prototype draws it (`UX.md` §3, D-98): a fixed
 * 56px gutter on the left holding the time in the mono face, then who and what — no
 * avatars, so a channel scans like a log, down a single edge.
 *
 * **Nothing here reflows.** The gutter is a fixed width; the time of a grouped message
 * (the same author within five minutes) is in the gutter but invisible until the row is
 * hovered or focused; the actions are an overlay in the row's corner, there from the
 * start and only faded in. A row is the same height whether the pointer is on it or not.
 *
 * **The row serves threads too.** It takes a `children` slot below the content for the
 * thread's summary line and its replies, and an `actions` slot beside the reaction
 * control, so the thread slice adds to a message without editing it; a reply is the same
 * row (grouped or not) with no thread of its own.
 *
 * **It is memoised.** A channel renders a page of fifty and a new message must not
 * re-render them: the props are primitives and stable references (the message object is
 * the cache's, and the cache keeps untouched messages as they were), so React's shallow
 * comparison is the whole check.
 */
import { memo } from 'react';
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import type { Delivery } from '../../realtime/engine';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { renderContent } from '../content/render-content';
import { ReactMenu, ReactionBar } from './reactions';

export interface MessageRowProps {
  readonly message: Message;
  /** Where the message is on its way to the server; `sent` for everything the server has. */
  readonly delivery?: Delivery;
  /** Why a failed send failed, in the server's words when it said any. */
  readonly failure?: string | null;
  /** The same author as the row above, within five minutes: no name, the time on hover. */
  readonly grouped?: boolean;
  readonly meId: string;
  /** The current minute, as a number, so a row re-renders when its "12m ago" changes and not before. */
  readonly nowMinute: number;
  /** Who is who: user id to username, for the mentions the server resolved. */
  readonly members: ReadonlyMap<string, string>;
  /** Roving focus: 0 for the one row the keyboard reaches by Tab, -1 for the rest. */
  readonly tabIndex?: 0 | -1;
  /** Given the message's id, so one stable function serves every row and memoisation holds. */
  readonly onRetry?: (id: string) => void;
  readonly onDiscard?: (id: string) => void;
  /** More hover actions beside React — the thread slice's Reply. */
  readonly actions?: React.ReactNode;
  /** Below the content and the reactions: a thread's summary line and its replies. */
  readonly children?: React.ReactNode;
}

const MessageRowView = ({
  message,
  delivery = 'sent',
  failure = null,
  grouped = false,
  meId,
  nowMinute,
  members,
  tabIndex = -1,
  onRetry,
  onDiscard,
  actions,
  children,
}: MessageRowProps): React.JSX.Element => {
  const { t, format } = useI18n();
  const mentionsMe = message.mentions.includes(meId);
  const mentioned = new Set(
    message.mentions.flatMap((id) => {
      const name = members.get(id);
      return name === undefined ? [] : [name.toLowerCase()];
    }),
  );
  const absolute = format.absolute(message.createdAt);
  const failed = delivery === 'failed';

  return (
    <article
      data-message-row=""
      data-message-id={message.id}
      tabIndex={tabIndex}
      aria-label={t('feed.row', { name: message.sender.username, when: absolute })}
      className={cn(
        'group relative flex gap-3 px-4 py-1',
        mentionsMe ? 'bg-accent-subtle' : 'hover:bg-surface-200',
        failed && 'border-l-marker border-danger',
      )}
    >
      <div className="flex w-gutter shrink-0 items-start justify-end gap-1 font-mono text-caption text-ink-muted">
        {delivery === 'sending' && <Icon name="sending" size="sm" label={t('delivery.sending')} />}
        <time
          dateTime={message.createdAt}
          title={absolute}
          className={
            grouped ? 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100' : undefined
          }
        >
          {format.time(message.createdAt, new Date(nowMinute))}
        </time>
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && <span className="text-heading text-ink">{message.sender.username}</span>}
        {mentionsMe && <VisuallyHidden>{`${t('message.mention')}. `}</VisuallyHidden>}
        {renderContent(message.content, { mentioned })}
        <ReactionBar message={message} meId={meId} />
        {failed && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            <span>{t('delivery.failed')}</span>
            {failure !== null && <span className="text-caption text-ink-muted">{failure}</span>}
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => {
                onRetry?.(message.id);
              }}
              className="underline"
            >
              {t('delivery.retry')}
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => {
                onDiscard?.(message.id);
              }}
              className="underline"
            >
              {t('delivery.delete')}
            </button>
          </div>
        )}
        {children}
      </div>

      {delivery === 'sent' && (
        <div className="absolute right-4 top-1 flex gap-1 rounded-md border-hairline border-border-strong bg-surface-100 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <ReactMenu message={message} meId={meId} />
          {actions}
        </div>
      )}
    </article>
  );
};

export const MessageRow = memo(MessageRowView);
