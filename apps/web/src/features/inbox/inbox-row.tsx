/**
 * One row of the inbox (D-106, D-162), drawn the same in the inbox's page and in its panel (D-208):
 * who, why, where and when on one line; the thread it is in; the message itself. A row is a button
 * that opens the message, and — while anything in it waits — Mark read beside it, its own control.
 */
import type { Channel, Notification } from '@purlay/types';
import { Icon, type GlyphName } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import type { Translate } from '../../i18n/types';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { listButtonClasses, listRowClasses } from '../../ui/list-column';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useChannelTitle } from '../channel/channel-header';
import { useMessageText } from '../content/github-event';
import { authorOf } from '../messages/author';
import { repliersOf, type InboxRow } from './group';
import { whyOf } from './why';

const glyphOf = (type: Notification['type']): GlyphName => {
  switch (type) {
    case 'mention':
      return 'notifications';
    case 'direct_message':
      return 'person';
    case 'thread_reply':
      return 'reply';
    case 'thread_resolved':
      return 'resolved';
    case 'channel_message':
      return 'channel';
  }
};

/** Where it happened keeps up to a third of the line, so a narrow window cuts the reason first. */
const PLACE = 'max-w-1/3 shrink-0 truncate';

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => (
  <span className={PLACE}>{useChannelTitle(channel)}</span>
);

/** The thread a reply row names (D-162): by its root's first line, and how many when gathered. */
const threadLineOf = (t: Translate, row: InboxRow, unread: boolean): string | null => {
  const { thread, type } = row.newest;
  if (type !== 'thread_reply' || thread === null) return null;
  const count = row.members.length;
  const { excerpt } = thread;
  if (count === 1) return excerpt === null ? null : t('inbox.thread.in', { excerpt });
  if (excerpt === null)
    return t(unread ? 'inbox.thread.newBare' : 'inbox.thread.seenBare', { count });
  return t(unread ? 'inbox.thread.new' : 'inbox.thread.seen', { count, excerpt });
};

/**
 * How much room a row takes: the inbox page's, or the panel's (D-208) — one line of the message,
 * tighter, and Mark read as an icon, since the panel is a glance and the page is the reading.
 */
export type RowDensity = 'page' | 'panel';

export const InboxRowItem = ({
  row,
  channel,
  me,
  now,
  onOpen,
  onRead,
  density = 'page',
}: {
  readonly density?: RowDensity;
  readonly row: InboxRow;
  readonly channel: Channel | undefined;
  readonly me: string;
  readonly now: Date;
  readonly onOpen: (row: InboxRow) => void;
  readonly onRead: (row: InboxRow) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const textOf = useMessageText();
  const notification = row.newest;
  const { message } = notification;
  const unread = row.members.some((n) => n.readAt === null);
  const gathered = row.members.length > 1;
  const author = authorOf(message, t('user.erased'));
  const repliers = repliersOf(row.members, t('user.erased'));
  const names = format.list([
    ...repliers.shown,
    ...(repliers.more > 0 ? [t('inbox.others', { count: repliers.more })] : []),
  ]);
  const threadLine = threadLineOf(t, row, unread);
  const panel = density === 'panel';
  const withOne =
    channel?.type === 'direct_message' && channel.peer !== null && channel.peers.length < 2;
  return (
    <li className={cn('group relative', listRowClasses)}>
      <button
        type="button"
        onClick={() => {
          onOpen(row);
        }}
        className={listButtonClasses(panel ? 'gap-2.5 px-4 py-2.5 max-narrow:px-4' : undefined)}
      >
        {/* Unread is a dot at the row's edge as well as full ink, never colour alone (#58). */}
        <span
          aria-hidden="true"
          className={cn(
            panel
              ? 'absolute top-4 left-1 size-dot rounded-pill'
              : 'absolute top-5 left-2 size-dot rounded-pill',
            unread ? 'bg-accent' : 'bg-transparent',
          )}
        />
        <Avatar
          name={author.displayName}
          username={author.username}
          {...(panel ? { size: 'sm' as const } : {})}
        />
        <span className="min-w-0 flex-1">
          {/* One line at any width: the reason gives way before the channel, the time never breaks (#679). */}
          <span className="flex items-baseline gap-2 whitespace-nowrap text-label text-ink-muted">
            <Icon name={glyphOf(notification.type)} size="sm" />
            <span className={cn('min-w-0 truncate', unread && 'font-semibold text-ink')}>
              {unread ? <VisuallyHidden>{`${t('sidebar.unread')} `}</VisuallyHidden> : null}
              {whyOf(t, notification, channel, me, names)}
            </span>
            {/* A conversation with one other person is that person, already named (#631). */}
            {!withOne && (
              <>
                <span aria-hidden="true">·</span>
                {channel === undefined ? (
                  <span className={PLACE}>{t('questions.unnamed')}</span>
                ) : (
                  <ChannelName channel={channel} />
                )}
              </>
            )}
            <time
              dateTime={notification.createdAt}
              className="ml-auto shrink-0 font-mono text-caption"
            >
              {format.time(notification.createdAt, now)}
            </time>
          </span>
          {/* Which thread: gathered, it is the row's headline; alone, a quiet line above the reply. */}
          {threadLine !== null && (
            <span
              className={cn(
                'mt-1 block truncate',
                gathered ? 'text-body font-medium' : 'text-label text-ink-muted',
                gathered && (unread ? 'text-ink' : 'text-ink-muted'),
              )}
            >
              {threadLine}
            </span>
          )}
          {/* Unread is said as the sidebar says it: in full ink, and read is muted (#58). */}
          <span
            className={cn(
              'mt-1 text-body',
              gathered || panel ? 'line-clamp-1' : 'line-clamp-2',
              unread && !gathered ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {textOf(message)}
          </span>
        </span>
      </button>
      {unread && panel && (
        // In the panel, the same control as an icon: the row is a line, and a labelled button covers it.
        <span className="absolute top-1 right-2 opacity-0 transition-opacity duration-hover ease-standard group-hover:opacity-100 focus-within:opacity-100">
          <IconButton
            glyph="confirm"
            label={t('inbox.markRead')}
            className="bg-surface-100"
            onClick={() => {
              onRead(row);
            }}
          />
        </span>
      )}
      {unread && !panel && (
        // Read without opening: beside the row, not inside its button, so each is its own control.
        <span className="absolute top-2 right-2 opacity-0 transition-opacity duration-hover ease-standard group-hover:opacity-100 focus-within:opacity-100 max-narrow:hidden">
          <Button
            variant="secondary"
            glyph="confirm"
            onClick={() => {
              onRead(row);
            }}
          >
            {t('inbox.markRead')}
          </Button>
        </span>
      )}
    </li>
  );
};
