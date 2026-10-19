/**
 * The inbox (D-106, `UX.md` §8): what the person was told in this workspace — named, written to
 * directly, answered in a thread, their question resolved — newest first, from channels they can
 * still see.
 *
 * A row is a button that takes the person to the message: its thread when it is a reply or the
 * question that was resolved, its channel otherwise. Opening one marks it read, and "Mark all read"
 * reads up to the newest one on screen, so what arrives after the person looked still waits. Both
 * paint before the server answers; refused, the list is asked again and the toast says why.
 *
 * Reading here lowers the channels' mention badges: the server recounts them and tells every
 * device (`CHANNEL_STATE`), so nothing here touches a channel's numbers.
 */
import { useMemo, useState } from 'react';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, Notification, NotificationPage } from '@purlay/types';
import { Icon, type GlyphName } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels, useNotifications } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';
import { authorOf } from '../messages/author';
import { useMessageText } from '../content/github-event';
import { targetOf, whyOf } from './why';

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

/** Marks these read in the cache, before the server is asked (CONTRIBUTING §1.9). */
const markLocally = (
  client: QueryClient,
  workspaceId: string,
  read: (notification: Notification) => boolean,
  at: string,
): void => {
  // Both views of the inbox: everything, and what is unread — a row read stays in the unread view,
  // muted, until the person looks again, so nothing jumps out from under the pointer.
  for (const key of [keys.notifications(workspaceId), keys.notifications(workspaceId, 'unread')]) {
    client.setQueryData<InfiniteData<NotificationPage>>(key, (data) =>
      data === undefined
        ? data
        : {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              data: page.data.map((n) => (n.readAt === null && read(n) ? { ...n, readAt: at } : n)),
            })),
          },
    );
  }
};

/** Whether two instants fall on the same day where the person is. */
const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => (
  <span className="min-w-0 truncate">{useChannelTitle(channel)}</span>
);

const Row = ({
  notification,
  channel,
  now,
  onOpen,
  onRead,
}: {
  readonly notification: Notification;
  readonly channel: Channel | undefined;
  readonly now: Date;
  readonly onOpen: (notification: Notification) => void;
  readonly onRead: (notification: Notification) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const textOf = useMessageText();
  const { message } = notification;
  const unread = notification.readAt === null;
  const author = authorOf(message, t('user.erased'));
  const withOne =
    channel?.type === 'direct_message' && channel.peer !== null && channel.peers.length < 2;
  return (
    <li className="group relative not-first:border-t-hairline border-border-subtle">
      <button
        type="button"
        onClick={() => {
          onOpen(notification);
        }}
        className="flex w-full items-start gap-3 py-3 pr-4 pl-5 text-left transition-colors duration-hover ease-standard hover:bg-surface-050 max-narrow:pl-4"
      >
        {/* Unread is a dot at the row's edge as well as full ink, never colour alone (#58). */}
        <span
          aria-hidden="true"
          className={cn(
            'absolute top-5 left-2 size-dot rounded-pill',
            unread ? 'bg-accent' : 'bg-transparent',
          )}
        />
        <Avatar name={author.displayName} username={author.username} />
        <span className="min-w-0 flex-1">
          {/* One line at any width: the reason and the channel give way, the time never breaks (#679). */}
          <span className="flex items-baseline gap-2 whitespace-nowrap text-label text-ink-muted">
            <Icon name={glyphOf(notification.type)} size="sm" />
            <span className={cn('min-w-0 truncate', unread && 'font-semibold text-ink')}>
              {unread ? <VisuallyHidden>{`${t('sidebar.unread')} `}</VisuallyHidden> : null}
              {whyOf(t, notification, channel)}
            </span>
            {/* A conversation with one other person is that person, already named (#631). */}
            {!withOne && (
              <>
                <span aria-hidden="true">·</span>
                {channel === undefined ? (
                  <span className="min-w-0 truncate">{t('questions.unnamed')}</span>
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
          {/* Unread is said as the sidebar says it: in full ink, and read is muted (#58). */}
          <span
            className={cn(
              'mt-1 line-clamp-2 block text-body',
              unread ? 'text-ink' : 'text-ink-muted',
            )}
          >
            {textOf(message)}
          </span>
        </span>
      </button>
      {unread && (
        // Read without opening: beside the row, not inside its button, so each is its own control.
        <span className="absolute top-2 right-2 opacity-0 transition-opacity duration-hover ease-standard group-hover:opacity-100 focus-within:opacity-100 max-narrow:hidden">
          <Button
            variant="secondary"
            glyph="confirm"
            onClick={() => {
              onRead(notification);
            }}
          >
            {t('inbox.markRead')}
          </Button>
        </span>
      )}
    </li>
  );
};

/** One day's notifications, in a card: Today, or Earlier. */
const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <section className="flex flex-col gap-2">
    <h2 className="text-label text-ink-muted">{title}</h2>
    <ul className="overflow-hidden rounded-xl border-hairline border-border-subtle bg-surface-100 shadow-card">
      {children}
    </ul>
  </section>
);

export const InboxScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const ports = useFeedPorts();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const query = useNotifications(workspace.id, filter === 'unread');
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const all = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.data), [query.data]);
  const now = ports.clock.now();

  /** Paints, asks, and on a refusal asks for the list again and says why. */
  const read = (marked: (n: Notification) => boolean, ask: () => Promise<void>): void => {
    markLocally(client, workspace.id, marked, ports.clock.now().toISOString());
    ask().catch((failure: unknown) => {
      void client.invalidateQueries({ queryKey: keys.notifications(workspace.id) });
      show({ message: `${t('inbox.readFailed')} ${describe(failure)}` });
    });
  };

  const open = (notification: Notification): void => {
    if (notification.readAt === null) {
      read(
        (n) => n.id === notification.id,
        () => api.readNotifications({ ids: [notification.id] }),
      );
    }
    navigate(targetOf(workspace.slug, notification));
  };

  const readOne = (notification: Notification): void => {
    read(
      (n) => n.id === notification.id,
      () => api.readNotifications({ ids: [notification.id] }),
    );
  };

  const newest = all[0];
  const anyUnread = all.some((n) => n.readAt === null);

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus label={t('state.inbox.loading')} className="flex flex-col gap-4 py-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-feed" />
          </div>
        ))}
      </LoadingStatus>
    );
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title={t('state.inbox.error.title')}
        body={t('state.inbox.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (all.length === 0) {
    body =
      filter === 'unread' ? (
        <GlyphEmptyState
          glyph="confirm"
          tone="success"
          title={t('inbox.unreadEmpty.title')}
          body={t('inbox.unreadEmpty.body')}
        />
      ) : (
        <GlyphEmptyState
          glyph="notifications"
          tone="success"
          title={t('state.inbox.empty.title')}
          body={t('state.inbox.empty.body')}
        />
      );
  } else {
    const today = all.filter((n) => sameDay(new Date(n.createdAt), now));
    const earlier = all.filter((n) => !sameDay(new Date(n.createdAt), now));
    const rows = (list: readonly Notification[]): React.JSX.Element[] =>
      list.map((notification) => (
        <Row
          key={notification.id}
          notification={notification}
          channel={byId.get(notification.channelId)}
          now={now}
          onOpen={open}
          onRead={readOne}
        />
      ));
    body = (
      <div className="flex flex-col gap-6">
        {today.length > 0 && <Section title={t('message.today')}>{rows(today)}</Section>}
        {earlier.length > 0 && <Section title={t('inbox.earlier')}>{rows(earlier)}</Section>}
        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('inbox.more')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-5">
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <HeaderTile>
            <Icon name="notifications" size="lg" />
          </HeaderTile>
          <div className="flex min-w-0 flex-col">
            <h1 className="whitespace-nowrap text-heading text-ink">{t('inbox.title')}</h1>
            <span className="truncate text-caption text-ink-muted max-narrow:hidden">
              {t('inbox.lede')}
            </span>
          </div>
        </div>
        {newest !== undefined && anyUnread && (
          <Button
            variant="ghost"
            glyph="confirm"
            onClick={() => {
              const before = newest.id;
              const shown = new Set(all.map((n) => n.id));
              read(
                (n) => shown.has(n.id),
                () => api.readNotifications({ workspaceId: workspace.id, before }),
              );
            }}
          >
            {t('inbox.readAll')}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface-000">
        <div className="mx-auto flex w-full max-w-feed flex-col gap-4 px-6 pt-6 pb-10 max-narrow:px-4 max-narrow:pt-4">
          <div
            role="group"
            aria-label={t('inbox.show')}
            className="flex self-start rounded-lg bg-surface-200 p-1"
          >
            {(['all', 'unread'] as const).map((choice) => (
              <button
                key={choice}
                type="button"
                aria-pressed={filter === choice}
                onClick={() => {
                  setFilter(choice);
                }}
                className={cn(
                  'inline-flex h-control items-center rounded-md px-3 text-label transition-colors duration-hover ease-standard max-narrow:h-touch',
                  filter === choice
                    ? 'bg-surface-100 text-ink shadow-card'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {t(`inbox.filter.${choice}`)}
              </button>
            ))}
          </div>
          {body}
        </div>
      </div>
    </>
  );
};
