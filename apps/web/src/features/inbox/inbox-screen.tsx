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
import { useMemo } from 'react';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, Notification, NotificationPage } from '@purlay/types';
import { Icon, type GlyphName } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels, useNotifications } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href, threadHref } from '../../router/routes';
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

/** Why the person was told, in words: who did it, except for a resolution of their own question. */
const useWhy = (): ((notification: Notification, channel: Channel | undefined) => string) => {
  const { t } = useI18n();
  return (notification, channel) => {
    const name = authorOf(notification.message, t('user.erased')).username;
    switch (notification.type) {
      case 'mention':
        return t('inbox.why.mention', { name });
      case 'direct_message':
        // In a group it was written to several people, not to you alone (D-127).
        return channel !== undefined && channel.peers.length >= 2
          ? t('inbox.why.group', { name })
          : t('inbox.why.direct', { name });
      case 'thread_reply':
        return t('inbox.why.reply', { name });
      case 'thread_resolved':
        return t('inbox.why.resolved');
      case 'channel_message':
        return t('inbox.why.channel', { name });
    }
  };
};

/** Where a notification takes the person: the thread a reply or a resolution belongs to, or the channel. */
export const targetOf = (slug: string, notification: Notification): string => {
  const { message } = notification;
  if (message.parentId !== null) return threadHref(slug, message.channelId, message.parentId);
  if (notification.type === 'thread_resolved' || notification.type === 'thread_reply') {
    return threadHref(slug, message.channelId, message.id);
  }
  return href('channel', { slug, channelId: message.channelId });
};

/** Marks these read in the cache, before the server is asked (CONTRIBUTING §1.9). */
const markLocally = (
  client: QueryClient,
  workspaceId: string,
  read: (notification: Notification) => boolean,
  at: string,
): void => {
  client.setQueryData<InfiniteData<NotificationPage>>(keys.notifications(workspaceId), (data) =>
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
};

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => (
  <span>{useChannelTitle(channel)}</span>
);

const Row = ({
  notification,
  channel,
  now,
  onOpen,
}: {
  readonly notification: Notification;
  readonly channel: Channel | undefined;
  readonly now: Date;
  readonly onOpen: (notification: Notification) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const textOf = useMessageText();
  const { message } = notification;
  const why = useWhy();
  const unread = notification.readAt === null;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onOpen(notification);
        }}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-hover ease-standard hover:bg-surface-050"
      >
        <Avatar
          name={authorOf(message, t('user.erased')).displayName}
          username={authorOf(message, t('user.erased')).username}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-label text-ink-muted">
            <Icon name={glyphOf(notification.type)} size="sm" />
            <span className={cn(unread && 'font-medium text-ink')}>
              {unread ? <VisuallyHidden>{`${t('sidebar.unread')} `}</VisuallyHidden> : null}
              {why(notification, channel)}
            </span>
            <span aria-hidden="true">·</span>
            {channel === undefined ? t('questions.unnamed') : <ChannelName channel={channel} />}
            <time dateTime={notification.createdAt} className="ml-auto font-mono text-caption">
              {format.time(notification.createdAt, now)}
            </time>
          </span>
          {/* Unread is said as the sidebar says it: in full ink, and read is muted (#58). */}
          <span className={cn('block truncate text-body', unread ? 'text-ink' : 'text-ink-muted')}>
            {textOf(message)}
          </span>
        </span>
      </button>
    </li>
  );
};

export const InboxScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const ports = useFeedPorts();
  const query = useNotifications(workspace.id);
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

  const newest = all[0];
  const anyUnread = all.some((n) => n.readAt === null);

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus
        label={t('state.inbox.loading')}
        className="flex w-full max-w-feed flex-col gap-4 px-4 py-4"
      >
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
    body = (
      <GlyphEmptyState
        glyph="notifications"
        tone="success"
        title={t('state.inbox.empty.title')}
        body={t('state.inbox.empty.body')}
      />
    );
  } else {
    body = (
      <div className="flex w-full max-w-feed flex-col gap-4 px-3 py-4">
        <ul className="flex flex-col">
          {all.map((notification) => (
            <Row
              key={notification.id}
              notification={notification}
              channel={byId.get(notification.channelId)}
              now={now}
              onOpen={open}
            />
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="px-3">
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
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </>
  );
};
