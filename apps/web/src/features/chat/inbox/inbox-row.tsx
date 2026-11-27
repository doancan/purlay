/**
 * One row of the inbox's page (D-106, D-162):
 * who, why, where and when on one line; the thread it is in; the message itself. A row is a button
 * that opens the message, and — while anything in it waits — Mark read beside it, its own control.
 */
import type { Channel, Notification } from '@purlay/types';
import { Icon, type GlyphName } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import type { Translate } from '../../../i18n/types';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { listButtonClasses, listRowClasses } from '../../../ui/list-column';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { useChannelTitle } from '../channel/channel-header';
import { PriorityMark } from '../messages/priority';
import { useMessageText } from '../../content/github-event';
import { authorOf } from '../../../lib/author';
import { repliersOf, type InboxRow } from './group';
import { whyOf } from '../../../lib/notification-why';

const glyphOf = (type: Notification['type']): GlyphName => {
  switch (type) {
    case 'reminder':
      return 'notifications';
    // The Mentions tab's own mark, so a row and the category it is filed under agree.
    case 'mention':
      return 'mention';
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

export const InboxRowItem = ({
  row,
  channel,
  me,
  now,
  onOpen,
  onRead,
}: {
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
  const withOne =
    channel?.type === 'direct_message' && channel.peer !== null && channel.peers.length < 2;
  return (
    <li className={cn('group relative', listRowClasses)}>
      <button
        type="button"
        onClick={() => {
          onOpen(row);
        }}
        className={listButtonClasses()}
      >
        {/* Unread is a dot at the row's edge as well as full ink, never colour alone (#58). */}
        <span
          aria-hidden="true"
          className={cn(
            // A phone's row is narrower at its edge: the dot moves with it, to keep its gap to the avatar.
            'absolute top-5 left-2 size-dot rounded-pill max-narrow:left-1',
            unread ? 'bg-accent' : 'bg-transparent',
          )}
        />
        <Avatar name={author.displayName} username={author.username} />
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
              gathered ? 'line-clamp-1' : 'line-clamp-2',
              unread && !gathered ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {textOf(message)}
          </span>
          <PriorityMark message={message} />
        </span>
      </button>
      {unread && (
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
