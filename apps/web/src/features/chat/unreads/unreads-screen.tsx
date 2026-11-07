/**
 * All unreads (D-216): what is new in every channel the person has not read, on one screen, channel by
 * channel — Slack's "Unreads".
 *
 * - **Only what is new**: the server's oldest unread roots in the membership's join/historical scope,
 *   20 at a time, plus separately paginated waiting threads (D-282).
 * - **Mark read reads what was shown**, up to its newest: nothing the person did not see is marked read,
 *   and a channel with more waiting shows its next page.
 * - **Replies wait in their threads** (D-147): their roots provide context; the primary link opens the
 *   exact first unread reply. A thread read leaves the feed and other threads waiting.
 * - **Quiet channels are not here**: one set to tell nothing (D-107) is not asking to be caught up on.
 * - **In the sidebar's order**, so a channel is where the person expects it; the state is the channels'
 *   cache, so a frame that reads one elsewhere takes it off this screen too.
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';
import { CATCH_UP_PAGE, type Channel, type Message, type UnreadThread } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useActions } from '../../../data/actions-provider';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useChannels, useMembers } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { Link } from '../../../router/router-provider';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { ListCard, ListColumn } from '../../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../../ui/states';
import { useToast } from '../../../ui/toast';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { renderContent } from '../../content/render-content';
import { authorOf } from '../../../lib/author';
import { useSession } from '../../session/session';
import { NavToggle } from '../../shell/nav';
import { useWorkspace } from '../../shell/workspace';
import { waitingChannels } from './waiting';
import { Attachments } from '../messages/attachments';
import { GitHubEventCard } from '../../content/github-event';
import { GitHubCards } from '../../content/github-cards';
import { WebLinkCards } from '../../content/web-link-cards';
import { MessageCards } from '../../content/message-cards';

/** How many new messages a channel shows at once: enough to catch up, few enough to scan. */
export const UNREADS_PAGE = CATCH_UP_PAGE;

const Line = ({
  message,
  names,
  repository,
  unreadThread,
}: {
  readonly message: Message;
  readonly unreadThread?: UnreadThread;
  /** The channel's repository, for its code references (D-223). */
  readonly repository: string | null;
  /** Members by id, as usernames: who the message mentions, highlighted as the feed does. */
  readonly names: ReadonlyMap<string, string>;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { clock } = useFeedPorts();
  const { user: me } = useSession();
  const { workspace } = useWorkspace();
  const author = authorOf(message, t('user.erased'));
  const mentioned = new Set(
    message.mentions.flatMap((id) => {
      const name = names.get(id);
      return name === undefined ? [] : [name.toLowerCase()];
    }),
  );
  return (
    <li className="flex gap-3 px-5 py-3 not-first:border-t-hairline border-border-subtle max-narrow:px-4">
      <Avatar size="sm" name={author.displayName} username={author.username} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-label font-semibold text-ink">{author.displayName}</span>
          <time dateTime={message.createdAt} className="font-mono text-caption text-ink-muted">
            {format.time(message.createdAt, clock.now())}
          </time>
        </div>
        {message.deletedAt !== null ? (
          <p className="text-body text-ink-muted">{t('message.deleted')}</p>
        ) : (
          <>
            {message.githubEvent !== null ? (
              <GitHubEventCard event={message.githubEvent} />
            ) : (
              renderContent(message.content, {
                mentioned,
                me: me.username.toLowerCase(),
                repository,
              })
            )}
            {message.githubEvent === null && <GitHubCards content={message.content} />}
            {message.githubEvent === null && (
              <WebLinkCards
                channelId={message.channelId}
                messageId={message.id}
                content={message.content}
              />
            )}
            {message.githubEvent === null && <MessageCards content={message.content} />}
            <Attachments
              attachments={message.attachments}
              sharedBy={author.displayName}
              sharedAt={message.createdAt}
            />
          </>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-caption">
          {unreadThread !== undefined && (
            <Link
              to="channel"
              params={{ slug: workspace.slug, channelId: message.channelId }}
              search={new URLSearchParams({
                message: unreadThread.firstUnreadMessageId,
              }).toString()}
              className="font-medium text-accent-text hover:underline"
            >
              {t('unreads.openReplies')} · {t('unreads.count', { count: unreadThread.unreadCount })}
            </Link>
          )}
          {message.deletedAt === null && (
            <Link
              to="channel"
              params={{ slug: workspace.slug, channelId: message.channelId }}
              search={new URLSearchParams({ message: message.id }).toString()}
              className="font-medium text-accent-text hover:underline"
            >
              {t('unreads.openMessage')}
            </Link>
          )}
          {unreadThread === undefined &&
            message.thread !== null &&
            message.thread.replyCount > 0 && (
              <Link
                to="channel"
                params={{ slug: workspace.slug, channelId: message.channelId }}
                search={new URLSearchParams({ thread: message.id }).toString()}
                className="font-medium text-accent-text hover:underline"
              >
                {t('thread.show')} · {t('thread.replies', { count: message.thread.replyCount })}
              </Link>
            )}
        </div>
      </div>
    </li>
  );
};

const ChannelUnreads = ({
  channel,
  names,
}: {
  readonly channel: Channel;
  readonly names: ReadonlyMap<string, string>;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const { markRead } = useActions();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const title = useChannelTitle(channel);
  const headingId = useId();
  const [reading, setReading] = useState(false);
  const state = channel.state;
  const position = state?.lastReadMessageId ?? null;
  const unread = state?.unreadCount ?? 0;
  // Keyed by the position and the count: read elsewhere, or a new message, and it is asked again.
  const client = useQueryClient();
  const page = useInfiniteQuery({
    queryKey: keys.unreads(channel.id, position, unread),
    queryFn: async ({ pageParam, signal }) =>
      await api.unreads(
        channel.id,
        { limit: UNREADS_PAGE, ...(pageParam === undefined ? {} : { afterThread: pageParam }) },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextThreadCursor ?? undefined,
  });
  const threads = useMemo(
    () => [
      ...new Map(
        (page.data?.pages.flatMap((part) => part.threads) ?? []).map((thread) => [
          thread.root.id,
          thread,
        ]),
      ).values(),
    ],
    [page.data],
  );
  if (state === null) return null;
  const roots = page.data?.pages[0]?.roots;
  const shown = roots?.data ?? [];
  const newest = shown.at(-1);
  const failed = page.isError && !page.isFetchNextPageError;
  return (
    <ListCard
      headingId={headingId}
      heading={
        <div className="flex flex-wrap items-center gap-3">
          <h2
            id={headingId}
            className="min-w-0 flex-1 basis-16 truncate text-label font-semibold text-ink"
          >
            <Link
              to="channel"
              params={{ slug: workspace.slug, channelId: channel.id }}
              className="hover:underline"
            >
              {title}
            </Link>
          </h2>
          <span className="shrink-0 text-caption text-ink-muted">
            {t('unreads.count', { count: unread })}
          </span>
          {newest !== undefined && !failed && (
            <span className="ml-auto">
              <Button
                variant="ghost"
                glyph="confirm"
                busy={reading}
                onClick={() => {
                  setReading(true);
                  markRead(channel.id, newest.id)
                    .catch((failure: unknown) => {
                      show({ message: `${t('unreads.readFailed')} ${describe(failure)}` });
                    })
                    .finally(() => {
                      setReading(false);
                    });
                }}
              >
                {t('unreads.markRead')}
              </Button>
            </span>
          )}
        </div>
      }
    >
      {page.isPending ? (
        <li className="px-5 py-3">
          <LoadingStatus label={t('unreads.loading')} className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-feed" />
          </LoadingStatus>
        </li>
      ) : failed ? (
        <li className="flex items-center gap-3 px-5 py-3 text-label text-danger-text">
          {t('unreads.failed')}
          <Button
            variant="secondary"
            onClick={() => {
              void page.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </li>
      ) : (
        <>
          {shown.map((message) => (
            <Line
              key={message.id}
              message={message}
              names={names}
              repository={channel.codeRepository}
            />
          ))}
          {threads.length > 0 && (
            <li className="border-t-hairline border-border-subtle px-5 py-3">
              <h3 className="text-label font-semibold text-ink-muted">
                {t('unreads.threadsTitle')}
              </h3>
            </li>
          )}
          {threads.map((thread) => (
            <Line
              key={`thread-${thread.root.id}`}
              message={thread.root}
              unreadThread={thread}
              names={names}
              repository={channel.codeRepository}
            />
          ))}
          {page.hasNextPage && (
            <li className="px-5 py-3">
              {page.isFetchNextPageError && (
                <p className="mb-2 text-label text-danger-text">{t('unreads.failed')}</p>
              )}
              <Button
                variant="secondary"
                busy={page.isFetchingNextPage}
                onClick={() => {
                  void page.fetchNextPage();
                }}
              >
                {page.isFetchNextPageError ? t('common.retry') : t('unreads.moreThreads')}
              </Button>
            </li>
          )}
          {shown.length === 0 && threads.length === 0 && (
            <li className="flex flex-wrap items-center gap-3 px-5 py-3 text-label text-ink-muted">
              {t('unreads.changed')}
              <Button
                variant="secondary"
                onClick={() => {
                  void client.invalidateQueries({ queryKey: keys.channels(workspace.id) });
                  void page.refetch();
                }}
              >
                {t('common.retry')}
              </Button>
            </li>
          )}
          {roots?.nextCursor != null && (
            <li className="px-5 py-3 not-first:border-t-hairline border-border-subtle">
              <Link
                to="channel"
                params={{ slug: workspace.slug, channelId: channel.id }}
                className="text-label font-medium text-accent-text hover:underline"
              >
                {t('unreads.more', { channel: title })}
              </Link>
            </li>
          )}
        </>
      )}
    </ListCard>
  );
};

export const UnreadsScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const waiting = useMemo(() => waitingChannels(channels.data ?? []), [channels.data]);
  const members = useMembers(workspace.id).data;
  const names = useMemo(
    () => new Map((members ?? []).map((member) => [member.user.id, member.user.username])),
    [members],
  );
  return (
    <>
      <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4">
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <HeaderTile>
            <Icon name="channels" size="lg" />
          </HeaderTile>
          <h1 className="whitespace-nowrap text-heading text-ink">{t('unreads.title')}</h1>
        </div>
      </header>
      <ListColumn>
        {channels.isPending ? (
          <LoadingStatus label={t('unreads.loading')} className="flex flex-col gap-4 py-2">
            <Skeleton className="w-members" />
            <Skeleton className="w-feed" />
          </LoadingStatus>
        ) : channels.isError ? (
          <ErrorState
            title={t('unreads.failed')}
            body={t('unreads.failedBody')}
            retryLabel={t('common.retry')}
            onRetry={() => {
              void channels.refetch();
            }}
          />
        ) : waiting.length === 0 ? (
          <GlyphEmptyState
            glyph="confirm"
            tone="success"
            title={t('unreads.empty.title')}
            body={t('unreads.empty.body')}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {waiting.map((channel) => (
              <ChannelUnreads key={channel.id} channel={channel} names={names} />
            ))}
          </div>
        )}
      </ListColumn>
    </>
  );
};
