/**
 * One message (`UX.md` §3, D-100): an avatar in a fixed column, then a header line — the name
 * and the time side by side — and the content under it. No bubbles: a bubble turns a code block
 * into a box inside a box, and a message here is half code.
 *
 * **Nothing here reflows.** The avatar column is a fixed width; a grouped message (the same
 * author within five minutes) has no avatar and no header, and its time is in that column but
 * invisible until the row is hovered or focused; the actions are an overlay in the row's corner,
 * there from the start and only faded in. A row is the same height whether the pointer is on it
 * or not.
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
import { memo, useState } from 'react';
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { Avatar } from '../../ui/avatar';
import { failureKey, type FailureCode } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import type { Delivery } from '../../realtime/engine';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { renderContent } from '../content/render-content';
import { GitHubCards } from '../content/github-cards';
import { Attachments } from './attachments';
import { ReactMenu, ReactionBar } from './reactions';
import { MessageEditor, OwnActions, useEditing } from './editing';

export interface MessageRowProps {
  readonly message: Message;
  /** Where the message is on its way to the server; `sent` for everything the server has. */
  readonly delivery?: Delivery;
  /** Why a failed send failed, in the server's words when it said any. */
  readonly failure?: FailureCode | null;
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
  /**
   * A resolved thread's root is quiet: its text in the muted ink, so the feed gets calmer as
   * questions close (`UX.md` §4.3). Colour is not the only signal — the status line says so.
   */
  readonly dimmed?: boolean;
  /** A thread's reply: a smaller avatar, so the root stays the larger thing in the block. */
  readonly compact?: boolean;
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
  dimmed = false,
  compact = false,
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
  // A tombstone (D-103 §7): its words are gone, and so is anything to do with them.
  const deleted = message.deletedAt !== null;
  // The author's own, sent and not deleted: theirs to edit and delete (D-103).
  const mine = message.sender.id === meId && delivery === 'sent' && !deleted;
  const editing = useEditing().editingId === message.id && mine;
  // Whether the pointer or focus is on THIS row and not on a row nested inside it. A thread's
  // replies are rows inside the root's row, so CSS `group-hover` would show every reply's actions
  // whenever the root is hovered; the nearest row is the one that answers.
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const own = (event: React.SyntheticEvent): boolean =>
    event.target instanceof Element &&
    event.target.closest('[data-message-row]') === event.currentTarget;
  const on = pointed || focused;

  const time = (
    <time
      dateTime={message.createdAt}
      title={absolute}
      className={cn('font-mono text-caption text-ink-subtle', grouped && !on && 'opacity-0')}
    >
      {format.time(message.createdAt, new Date(nowMinute))}
    </time>
  );
  const sending = delivery === 'sending' && (
    <Icon name="sending" size="sm" label={t('delivery.sending')} />
  );

  return (
    <article
      data-editable={mine ? '' : undefined}
      onPointerOver={(event) => {
        setPointed(own(event));
      }}
      onPointerLeave={() => {
        setPointed(false);
      }}
      onFocus={(event) => {
        setFocused(own(event));
      }}
      onBlur={() => {
        setFocused(false);
      }}
      data-message-row=""
      data-message-id={message.id}
      tabIndex={tabIndex}
      aria-label={t('feed.row', { name: message.sender.username, when: absolute })}
      className={cn(
        'relative flex gap-3 rounded-lg px-2 transition-colors duration-hover ease-standard',
        grouped ? 'py-1' : 'pt-2 pb-1',
        mentionsMe ? 'bg-accent-subtle' : on && 'bg-surface-050',
        failed && 'border-l-marker border-danger',
      )}
    >
      <div
        className={cn(
          'flex h-auto shrink-0 items-start justify-center gap-1',
          compact ? 'size-avatar' : 'size-avatar-lg',
        )}
      >
        {grouped ? (
          <>
            {sending}
            {time}
          </>
        ) : (
          <Avatar
            name={message.sender.displayName}
            username={message.sender.username}
            size={compact ? 'md' : 'lg'}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-body font-semibold text-ink">{message.sender.username}</span>
            {time}
            {sending}
          </div>
        )}
        {mentionsMe && <VisuallyHidden>{`${t('message.mention')}. `}</VisuallyHidden>}
        <div className={dimmed || deleted ? 'text-ink-muted' : undefined}>
          {editing ? (
            <MessageEditor message={message} />
          ) : deleted ? (
            <p>{t('message.deleted')}</p>
          ) : (
            renderContent(message.content, { mentioned })
          )}
          {!deleted && message.editedAt !== null && (
            <span
              className="text-caption text-ink-subtle"
              title={format.absolute(message.editedAt)}
            >
              {t('message.edited')}
            </span>
          )}
        </div>
        {/* A tombstone hides what was shown with the words, as the server does (D-109 §6). */}
        {!deleted && <GitHubCards content={message.content} />}
        {!deleted && <Attachments attachments={message.attachments} />}
        {!deleted && <ReactionBar message={message} meId={meId} />}
        {failed && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            <span>{t('delivery.failed')}</span>
            {failure !== null && (
              <span className="text-caption text-ink-muted">{t(failureKey(failure))}</span>
            )}
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

      {delivery === 'sent' && !deleted && (
        <div
          className={cn(
            'absolute right-2 -top-3 flex gap-1 rounded-lg border-hairline border-border-subtle bg-surface-100 p-1 shadow-float transition-opacity duration-hover ease-standard',
            !on && 'opacity-0',
          )}
        >
          <ReactMenu message={message} meId={meId} />
          {actions}
          {mine && <OwnActions message={message} />}
        </div>
      )}
    </article>
  );
};

export const MessageRow = memo(MessageRowView);
