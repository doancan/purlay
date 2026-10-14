/**
 * One message (`UX.md` §3, D-119): a conversation with two edges. Everyone else's messages are
 * on the left, in a bubble on `surface-200`, with an avatar in a fixed column and their name over
 * the first bubble of a group; your own are on the right, in a bubble on `accent-subtle`, with no
 * avatar and no name. The time is beside the name (or alone, on your side) in the mono face.
 *
 * **Nothing here reflows.** The avatar and the name belong to the *first* message of a group, so a
 * message arriving below never changes the one above it; a grouped message (the same author
 * within five minutes) has neither, and its time is drawn in its place but invisible until the
 * row is hovered or focused. The actions are an overlay on the bubble's top corner, there from
 * the start and only faded in. A row is the same height whether the pointer is on it or not.
 *
 * **The row serves threads too.** It takes a `children` slot below the bubble for the line that
 * opens the thread in the panel, and an `actions` slot beside the reaction control, so the thread
 * slice adds to a message without editing it; a reply is the same row (grouped or not) in the
 * panel, with no thread of its own, on its author's side (D-122).
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
import { GitHubEventCard } from '../content/github-event';
import { ImageLinks } from '../content/image-links';
import { Attachments } from './attachments';
import { authorOf, isMine } from './author';
import { EditedMark } from './edit-history';
import { ReactMenu, ReactionBar } from './reactions';
import { MessageEditor, OwnActions, useEditing } from './editing';
import { SaveToggle } from '../saved/save-toggle';
import { PinnedMark, PinToggle } from '../pins/pin-toggle';

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
  /** This root's thread is the one open in the panel (D-122): the row says so, to the eye and to a test. */
  readonly threadOpen?: boolean;
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
  threadOpen = false,
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
  // The author's own, sent and not deleted: theirs to edit and delete (D-103). An event is nobody's.
  const mine = isMine(message, meId) && delivery === 'sent' && !deleted;
  const author = authorOf(message, t('user.erased'));
  const event = deleted ? null : message.githubEvent;
  const editing = useEditing().editingId === message.id && mine;
  // Whether the pointer or focus is on THIS row and not on a row nested inside it. Replies were
  // once rows inside the root's row, where CSS `group-hover` showed every reply's actions whenever
  // the root was hovered; they are in the thread panel now (D-122), and the nearest row still
  // answers, so a row placed inside another never again lights up both.
  const [pointed, setPointed] = useState(false);
  const [focused, setFocused] = useState(false);
  const own = (event: React.SyntheticEvent): boolean =>
    event.target instanceof Element &&
    event.target.closest('[data-message-row]') === event.currentTarget;
  const on = pointed || focused;

  // Which edge the message sits on: the person's own on the right, everyone else's on the left.
  const outgoing = isMine(message, meId);

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
      data-outgoing={outgoing ? '' : undefined}
      data-thread-open={threadOpen ? '' : undefined}
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
      aria-label={t('feed.row', { name: author.username, when: absolute })}
      className={cn(
        'relative flex gap-3 rounded-lg px-2',
        grouped ? 'pt-1' : 'pt-3',
        outgoing && 'flex-row-reverse',
      )}
    >
      {!outgoing && (
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
              name={author.displayName}
              username={author.username}
              size={compact ? 'md' : 'lg'}
            />
          )}
        </div>
      )}

      <div className={cn('flex min-w-0 flex-1 flex-col', outgoing ? 'items-end' : 'items-start')}>
        {!grouped && (
          <div className="mb-1 flex items-baseline gap-2 px-1">
            {!outgoing && (
              <span className="text-label font-semibold text-ink">{author.displayName}</span>
            )}
            {time}
            {sending}
          </div>
        )}
        {mentionsMe && <VisuallyHidden>{`${t('message.mention')}. `}</VisuallyHidden>}
        <div
          // The full column, so the bubble's five sixths are of the column and not of itself.
          className={cn('flex w-full items-end gap-2', outgoing && 'flex-row-reverse')}
        >
          <div
            data-bubble=""
            className={cn(
              'relative min-w-0 max-w-5/6 rounded-2xl px-3 py-2',
              outgoing ? 'bg-accent-subtle' : 'bg-surface-200',
              (dimmed || deleted) && 'text-ink-muted',
              failed && 'border-l-marker border-danger',
              editing && 'w-full max-w-full',
            )}
          >
            {editing ? (
              <MessageEditor message={message} />
            ) : deleted ? (
              <p>{t('message.deleted')}</p>
            ) : event !== null ? (
              <GitHubEventCard event={event} />
            ) : (
              renderContent(message.content, { mentioned, me: members.get(meId)?.toLowerCase() })
            )}
            <EditedMark message={message} mine={isMine(message, meId)} />
            {!deleted && <PinnedMark message={message} />}
            {delivery === 'sent' && !deleted && (
              <div
                className={cn(
                  'absolute -top-4 flex rounded-lg border-hairline border-border-subtle bg-surface-100 p-1 shadow-card transition-opacity duration-hover ease-standard',
                  // The inner corner (D-119 §6) — but your own short bubble is narrower than the
                  // actions, which then ran past the feed's edge and scrolled the whole conversation
                  // sideways; on your own they hang from the corner that is always inside.
                  'right-2',
                  // Hidden, it must not take a click meant for the words under it.
                  !on && 'pointer-events-none opacity-0',
                )}
              >
                <ReactMenu message={message} meId={meId} />
                <SaveToggle message={message} />
                <PinToggle message={message} />
                {actions}
                {mine && <OwnActions message={message} />}
              </div>
            )}
          </div>
          {/* Your own grouped message has no avatar column, so its time waits beside the bubble. */}
          {outgoing && grouped && (
            <span className="flex shrink-0 items-center gap-1 pb-1">
              {sending}
              {time}
            </span>
          )}
        </div>
        {/* A tombstone hides what was shown with the words, as the server does (D-109 §6). */}
        {/* An event's words are its own summary: nothing in them to unfurl (D-134 §6). */}
        {!deleted && event === null && <GitHubCards content={message.content} />}
        {!deleted && event === null && <ImageLinks content={message.content} />}
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
        {children !== undefined && <div className="self-stretch">{children}</div>}
      </div>
    </article>
  );
};

export const MessageRow = memo(MessageRowView);
