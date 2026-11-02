/**
 * One message (`UX.md` §3, D-187): a conversation with one edge. Every message — yours included —
 * hangs from the left, with an avatar in a fixed column and the author's name over the first message
 * of a group, the way Slack draws it; there is no bubble, so a code block, a table or a quote has the
 * whole column to itself. The time is beside the name in the mono face.
 *
 * **Nothing here reflows.** The avatar and the name belong to the *first* message of a group, so a
 * message arriving below never changes the one above it; a grouped message (the same author
 * within five minutes) has neither, and its time is drawn in its place but invisible until the
 * row is the one showing its actions. The actions are a bar on the row's own top edge, in the
 * top-right corner (`message-actions.tsx`, D-150), there from the start and only faded
 * in. A row is the same height whether the pointer is on it or not.
 *
 * **The row serves threads too.** It takes a `children` slot below the message for the line that
 * opens the thread in the panel, and an `actions` slot beside the reaction control, so the thread
 * slice adds to a message without editing it; a reply is the same row (grouped or not) in the
 * panel, with no thread of its own, like any other (D-122).
 *
 * **It is memoised.** A channel renders a page of fifty and a new message must not
 * re-render them: the props are primitives and stable references (the message object is
 * the cache's, and the cache keeps untouched messages as they were), so React's shallow
 * comparison is the whole check.
 */
import { memo, useId, useRef } from 'react';
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { Avatar } from '../../ui/avatar';
import { failureKey, UNREACHED, type FailureCode } from '../../data/failure';
import { useCodeRepository } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import type { Delivery } from '../../realtime/engine';
import { cn } from '../../ui/cn';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { renderContent } from '../content/render-content';
import { GitHubCards } from '../content/github-cards';
import { MessageCards } from '../content/message-cards';
import { GitHubEventCard } from '../content/github-event';
import { ImageLinks } from '../content/image-links';
import { Attachments } from './attachments';
import { authorOf, isMine } from './author';
import { EditedMark } from './edit-history';
import { ReactionBar } from './reactions';
import { MessageEditor, useEditing } from './editing';
import { PinnedMark } from '../pins/pin-toggle';
import { useActiveRow } from './active-row';
import { MessageActions } from './message-actions';
import { useRowStops } from './row-stops';
import { useWorkspaceIfAny } from '../shell/workspace';

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
  /**
   * Roving focus: 0 for the one row the keyboard reaches by Tab, -1 for the rest. Whichever it is,
   * the controls inside a row are stops only while focus is in it (`row-stops.ts`).
   */
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
  /**
   * The message a link opened, for a moment (D-149): the row is tinted until the feed lets it go.
   * The tint fades by the hover token, which is nothing under reduced motion.
   */
  readonly landed?: boolean;
  /** More actions on the bar after React — the thread slice's Reply. */
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
  landed = false,
  actions,
  children,
}: MessageRowProps): React.JSX.Element => {
  const { t, format } = useI18n();
  // Where its code references link (D-223): the channel's one feed repository, or none.
  const repository = useCodeRepository(
    useWorkspaceIfAny()?.workspace.id ?? null,
    message.channelId,
  );
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
  // Whether this is the one row showing its actions: the row under the pointer, or the focused row
  // when the keyboard is in use, across the feed and the thread panel together (D-150). The nearest
  // row answers, so a row placed inside another never lights up both. Keyed by the row, not the
  // message: a thread's root is drawn in the feed and the panel at once, and is two rows.
  const rowKey = useId();
  const on = useActiveRow(rowKey);
  // The list is one Tab stop: what is inside this message is reached from it, and only while focus
  // is in it (`row-stops.ts`, D-168).
  const self = useRef<HTMLElement>(null);
  useRowStops(self);

  const own = isMine(message, meId);

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
      ref={self}
      data-editable={mine ? '' : undefined}
      data-own={own ? '' : undefined}
      data-thread-open={threadOpen ? '' : undefined}
      data-landed={landed ? '' : undefined}
      data-message-row=""
      data-message-id={message.id}
      data-row-key={rowKey}
      tabIndex={tabIndex}
      aria-label={t('feed.row', { name: author.displayName, when: absolute })}
      className={cn(
        'relative flex gap-3 rounded-lg px-2 transition-colors duration-hover ease-standard',
        grouped ? 'pt-1' : 'pt-3',
        landed && 'bg-warning-subtle',
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
            name={author.displayName}
            username={author.username}
            size={compact ? 'md' : 'lg'}
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col items-start">
        {!grouped && (
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-label font-semibold text-ink">{author.displayName}</span>
            {/* Said in words beside the name, not a badge: a hook's name is whatever its admin chose,
            and must not pass for a person's (D-245). */}
            {message.incomingWebhook !== undefined && (
              <span data-incoming-webhook="" className="text-caption text-ink-muted">
                {t('message.incomingWebhook')}
              </span>
            )}
            {time}
            {sending}
          </div>
        )}
        {mentionsMe && <VisuallyHidden>{`${t('message.mention')}. `}</VisuallyHidden>}
        <div
          data-body=""
          className={cn(
            'relative w-full min-w-0',
            (dimmed || deleted) && 'text-ink-muted',
            // The marker hangs in the gutter's gap, so the words stay under the name.
            failed && '-ml-2 border-l-marker border-danger pl-2',
          )}
        >
          {editing ? (
            <MessageEditor message={message} />
          ) : deleted ? (
            <p>{t('message.deleted')}</p>
          ) : event !== null ? (
            <GitHubEventCard event={event} />
          ) : (
            renderContent(message.content, {
              mentioned,
              me: members.get(meId)?.toLowerCase(),
              repository,
            })
          )}
          {/* What is known about the message — edited, pinned — on one line under its words, apart. */}
          <div className="mt-1 flex items-center gap-3 empty:hidden">
            <EditedMark message={message} mine={own} />
            {!deleted && <PinnedMark message={message} />}
          </div>
        </div>
        {/* A tombstone hides what was shown with the words, as the server does (D-109 §6). */}
        {/* An event's words are its own summary: nothing in them to unfurl (D-134 §6). */}
        {!deleted && event === null && <GitHubCards content={message.content} />}
        {!deleted && event === null && <MessageCards content={message.content} />}
        {!deleted && event === null && <ImageLinks content={message.content} />}
        {!deleted && (
          <Attachments
            attachments={message.attachments}
            sharedBy={author.displayName}
            sharedAt={message.createdAt}
          />
        )}
        {!deleted && <ReactionBar message={message} meId={meId} members={members} />}
        {failed && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-label text-danger-text">
            <Icon name="failed" size="sm" />
            <span>{t('delivery.failed')}</span>
            {failure !== null && (
              <span className="text-caption text-ink-muted">
                {UNREACHED.has(failure) ? t('delivery.unreached') : t(failureKey(failure))}
              </span>
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
      {/* None of them applies while the message is being edited, and they were drawn over the editor (#653). */}
      {delivery === 'sent' && !deleted && !editing && (
        <MessageActions
          message={message}
          meId={meId}
          mine={mine}
          rowKey={rowKey}
          shown={on}
          actions={actions}
        />
      )}
    </article>
  );
};

export const MessageRow = memo(MessageRowView);
