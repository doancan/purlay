/**
 * All unreads (D-216): what is new in every channel the person has not read, on one screen, channel by
 * channel — Slack's "Unreads".
 *
 * - **Only what is new**: each channel's roots after its read position, oldest first, as the feed's own
 *   `after` page reads them (D-8); a channel with more than a page says so and opens.
 * - **Mark read reads what was shown**, up to its newest: nothing the person did not see is marked read,
 *   and a channel with more waiting shows its next page.
 * - **Replies wait in their threads** (D-147): a channel whose unread are replies, with no new message in
 *   the feed, says so and opens — a reply is read in its thread, not here.
 * - **Quiet channels are not here**: one set to tell nothing (D-107) is not asking to be caught up on.
 * - **In the sidebar's order**, so a channel is where the person expects it; the state is the channels'
 *   cache, so a frame that reads one elsewhere takes it off this screen too.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { Channel, Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels, useMembers } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { ListCard, ListColumn } from '../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { GlyphEmptyState } from '../../ui/states';
import { useToast } from '../../ui/toast';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { renderContent } from '../content/render-content';
import { authorOf } from '../messages/author';
import { useSession } from '../session/session';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';
import { waitingChannels } from './waiting';

/** How many new messages a channel shows at once: enough to catch up, few enough to scan. */
export const UNREADS_PAGE = 20;

const Line = ({
  message,
  names,
  repository,
}: {
  readonly message: Message;
  /** The channel's repository, for its code references (D-223). */
  readonly repository: string | null;
  /** Members by id, as usernames: who the message mentions, highlighted as the feed does. */
  readonly names: ReadonlyMap<string, string>;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { clock } = useFeedPorts();
  const { user: me } = useSession();
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
        {renderContent(message.content, {
          mentioned,
          me: me.username.toLowerCase(),
          repository,
        })}
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
  const state = channel.state;
  const position = state?.lastReadMessageId ?? null;
  const unread = state?.unreadCount ?? 0;
  // Keyed by the position and the count: read elsewhere, or a new message, and it is asked again.
  const page = useQuery({
    queryKey: keys.unreads(channel.id, position, unread),
    queryFn: async ({ signal }) => {
      if (position !== null) {
        return await api.messages(channel.id, { after: position, limit: UNREADS_PAGE }, signal);
      }
      // Never read: the newest page, turned to read oldest first like the rest.
      const newest = await api.messages(channel.id, { limit: UNREADS_PAGE }, signal);
      return { ...newest, data: [...newest.data].reverse() };
    },
  });
  if (state === null) return null;
  const shown = page.data?.data ?? [];
  const newest = shown.at(-1);
  return (
    <ListCard
      heading={
        <div className="flex items-center gap-3">
          <Link
            to="channel"
            params={{ slug: workspace.slug, channelId: channel.id }}
            className="min-w-0 truncate text-label font-semibold text-ink hover:underline"
          >
            {title}
          </Link>
          <span className="shrink-0 text-caption text-ink-muted">
            {t('unreads.count', { count: unread })}
          </span>
          {newest !== undefined && (
            <span className="ml-auto">
              <Button
                variant="ghost"
                glyph="confirm"
                onClick={() => {
                  markRead(channel.id, newest.id).catch((failure: unknown) => {
                    show({ message: `${t('unreads.readFailed')} ${describe(failure)}` });
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
      ) : page.isError ? (
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
          {shown.length === 0 && (
            // What waits is replies, read in their threads (D-147), not new messages in the feed.
            <li className="flex items-center gap-3 px-5 py-3 text-label text-ink-muted">
              {t('unreads.inThreads', { count: unread })}
              <Link
                to="channel"
                params={{ slug: workspace.slug, channelId: channel.id }}
                className="font-medium text-accent-text hover:underline"
              >
                {t('unreads.open')}
              </Link>
            </li>
          )}
          {page.data.nextCursor !== null && (
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
