/** A personal list of followed conversations, without marking anything read. */
import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel, FollowedThread, ThreadFollow } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { families, keys } from '../../../data/keys';
import { readAgain } from '../../../data/cache';
import { useChannels, useFollowedThreads } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { authorOf } from '../../../lib/author';
import { href } from '../../../router/routes';
import { Link, useRoute } from '../../../router/router-provider';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import {
  ListCard,
  ListColumn,
  ListFilter,
  ListSkeleton,
  listButtonClasses,
  listRowClasses,
  ListHeader,
} from '../../../ui/list-column';
import { ErrorState, GlyphEmptyState } from '../../../ui/states';
import { useMessageText } from '../../content/github-event';
import { NavToggle } from '../../shell/nav';
import { useWorkspace } from '../../shell/workspace';
import { ChannelName, HeaderTile } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { useSetThreadFollow } from '../threads/follow-toggle';

const Row = ({
  item,
  channel,
  rowRef,
  moveFocus,
}: {
  readonly item: FollowedThread;
  readonly channel: Channel | undefined;
  readonly rowRef: (node: HTMLLIElement | null) => void;
  readonly moveFocus: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const client = useQueryClient();
  const setFollowing = useSetThreadFollow(item.root.id);
  const textOf = useMessageText();
  const text = textOf(item.root);
  const preview =
    text === '' ? (item.root.attachments[0]?.fileName ?? t('followed.conversation')) : text;
  const { root, unread } = item;
  const author = authorOf(root, t('user.erased'));
  const now = useFeedPorts().clock.now();
  const firstUnread = unread?.firstUnreadMessageId;
  const replies = root.thread?.replyCount ?? 0;
  const waiting = unread !== null && unread.count > 0;
  return (
    // Unfollow sits beside the row's link, on its first line, and the whole row tints under the pointer:
    // below it, the button was a line of its own and every row half empty.
    <li
      ref={rowRef}
      className={cn(
        'relative flex items-start transition-colors duration-hover ease-standard hover:bg-surface-050',
        listRowClasses,
      )}
    >
      <Link
        to="channel"
        params={{ slug: workspace.slug, channelId: root.channelId }}
        search={new URLSearchParams(
          firstUnread == null ? { thread: root.id } : { message: firstUnread },
        ).toString()}
        className={listButtonClasses('min-w-0 flex-1 rounded-lg pr-2 max-narrow:pr-2')}
      >
        {/* Unread is a dot at the row's edge as well as full ink, as the inbox says it (#58). */}
        {waiting && (
          <span
            aria-hidden="true"
            className="absolute top-5 left-2 size-dot rounded-pill bg-accent max-narrow:left-1"
          />
        )}
        <Avatar name={author.displayName} username={author.username} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-label text-ink-muted">
            <span className="min-w-0 font-semibold text-ink break-words">{author.displayName}</span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 break-words">
              {channel === undefined ? (
                t('followed.conversation')
              ) : (
                <ChannelName channel={channel} />
              )}
            </span>
            <time dateTime={item.activityAt} className="ml-auto tabular-nums text-caption">
              {format.time(item.activityAt, now)}
            </time>
          </span>
          <span className="line-clamp-2 text-body text-ink break-words">
            {root.deletedAt !== null ? t('message.deleted') : preview}
          </span>
          <span className="flex flex-wrap gap-x-2 gap-y-1 text-label text-ink-muted">
            <span>{t('thread.replies', { count: replies })}</span>
            {/* Nothing to read in a conversation nobody answered yet: saying so again is noise. */}
            {(unread === null || replies > 0 || waiting) && (
              <>
                <span aria-hidden="true">·</span>
                <span className={cn(waiting && 'font-semibold text-ink')}>
                  {unread === null
                    ? t('followed.unknown')
                    : unread.count === 0
                      ? t('followed.read')
                      : t('followed.unreadCount', { count: unread.count })}
                </span>
              </>
            )}
          </span>
        </span>
      </Link>
      <div className="shrink-0 pt-2 pr-3 max-narrow:pt-0 max-narrow:pr-2">
        {/* A phone keeps the column for the conversation: the glyph alone there, its name unchanged. */}
        <Button
          variant="ghost"
          glyph="deep-work"
          aria-label={t('followed.unfollow')}
          onClick={() => {
            // This list itself establishes the follow relation, even before the thread's toggle was opened.
            if (client.getQueryData<ThreadFollow>(keys.threadFollow(root.id)) === undefined)
              client.setQueryData<ThreadFollow>(keys.threadFollow(root.id), { following: true });
            moveFocus();
            setFollowing(false);
          }}
        >
          <span className="max-narrow:hidden">{t('followed.unfollow')}</span>
        </Button>
      </div>
    </li>
  );
};

export const FollowedScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { search, navigate } = useRoute();
  const client = useQueryClient();
  const ports = useFeedPorts();
  useEffect(() => {
    let wasVisible = ports.pageVisible();
    return ports.onPageVisibility(() => {
      const visible = ports.pageVisible();
      if (visible && !wasVisible) readAgain(client, families.followedThreads);
      wasVisible = visible;
    });
  }, [client, ports]);
  const unreadOnly = new URLSearchParams(search).get('filter') === 'unread';
  const query = useFollowedThreads(workspace.id, unreadOnly);
  const channels = useChannels(workspace.id);
  const byId = useMemo(
    () => new Map((channels.data ?? []).map((channel) => [channel.id, channel])),
    [channels.data],
  );
  const items = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? [])
      .flatMap((page) => page.data)
      .filter((item) => {
        if (seen.has(item.root.id)) return false;
        seen.add(item.root.id);
        return true;
      });
  }, [query.data]);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  return (
    <>
      {/* The list screens' one header: a band of the header's height, whatever the title's language. */}
      <ListHeader>
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <HeaderTile>
            <Icon name="notifications" size="lg" />
          </HeaderTile>
          <h1 ref={heading} tabIndex={-1} className="min-w-0 truncate text-heading text-ink">
            {t('followed.title')}
          </h1>
        </div>
      </ListHeader>
      <ListColumn>
        <ListFilter
          label={t('followed.filters')}
          value={unreadOnly ? 'unread' : 'all'}
          choices={[
            { value: 'all', label: t('followed.all') },
            { value: 'unread', label: t('followed.unread') },
          ]}
          onChange={(filter) => {
            navigate(
              `${href('followed', { slug: workspace.slug })}${filter === 'unread' ? '?filter=unread' : ''}`,
            );
          }}
        />
        {query.isError && (
          <ErrorState
            framed
            title={t(query.data === undefined ? 'followed.error' : 'followed.refreshError')}
            body={t('followed.errorBody')}
            retryLabel={t('common.retry')}
            onRetry={() => {
              if (query.isFetchNextPageError) void query.fetchNextPage();
              else void query.refetch();
            }}
          />
        )}
        {query.isPending ? (
          <ListSkeleton label={t('followed.loading')} />
        ) : items.length === 0 && !query.isError ? (
          <GlyphEmptyState
            glyph="notifications"
            tone="accent"
            title={t(unreadOnly ? 'followed.emptyUnread' : 'followed.empty')}
            body={t('followed.emptyBody')}
          />
        ) : (
          items.length > 0 && (
            <ListCard label={t('followed.title')}>
              {items.map((item, index) => (
                <Row
                  key={item.root.id}
                  item={item}
                  channel={byId.get(item.root.channelId)}
                  rowRef={(node) => {
                    if (node === null) rows.current.delete(item.root.id);
                    else rows.current.set(item.root.id, node);
                  }}
                  moveFocus={() => {
                    const next = items[index + 1] ?? items[index - 1];
                    (next === undefined
                      ? heading.current
                      : rows.current.get(next.root.id)?.querySelector<HTMLAnchorElement>('a')
                    )?.focus();
                  }}
                />
              ))}
            </ListCard>
          )
        )}
        {query.hasNextPage && !query.isFetchNextPageError && (
          <div className="flex justify-center">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('followed.more')}
            </Button>
          </div>
        )}
      </ListColumn>
    </>
  );
};
