/**
 * Saved (#484, D-128): the messages a person kept to come back to, in three tabs — In progress,
 * Archived, Completed — newest saved first, a page at a time. Each says where and who, opens its
 * conversation, and moves between the tabs or is let go: painted at once, and on a refusal the list
 * is read again and the toast says why. The tab is in the address (`?state=`), so Back returns to it.
 *
 * Only what the person can read now is listed: a save in a channel they left waits, unshown (D-128).
 */
import { useMemo } from 'react';
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import type { Channel, SavedItem, SavedPage, SavedState } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useToast } from '../../ui/toast';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';
import { authorOf } from '../messages/author';
import { useMessageText } from '../content/github-event';

const STATES = ['in_progress', 'archived', 'completed'] as const satisfies readonly SavedState[];

/** The tab an address names; In progress for anything else. */
export const stateIn = (search: string): SavedState => {
  const named = new URLSearchParams(search).get('state');
  return STATES.find((state) => state === named) ?? 'in_progress';
};

const pagesKey = (workspaceId: string, state: SavedState): readonly unknown[] => [
  ...keys.saved(workspaceId),
  'pages',
  state,
];

const useSaved = (
  workspaceId: string,
  state: SavedState,
): UseInfiniteQueryResult<InfiniteData<SavedPage>> => {
  const api = useApi();
  return useInfiniteQuery({
    queryKey: pagesKey(workspaceId, state),
    queryFn: ({ pageParam, signal }) => api.saved(workspaceId, state, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const title = useChannelTitle(channel);
  return <span>{channel.type === 'direct_message' ? title : `#${title}`}</span>;
};

/** What a saved message can be moved to from where it is. */
const MOVES: Readonly<Record<SavedState, readonly SavedState[]>> = {
  in_progress: ['completed', 'archived'],
  archived: ['in_progress', 'completed'],
  completed: ['in_progress', 'archived'],
};

const Row = ({
  item,
  channel,
  onOpen,
  onMove,
  onRemove,
}: {
  readonly item: SavedItem;
  readonly channel: Channel | undefined;
  readonly onOpen: () => void;
  readonly onMove: (to: SavedState) => void;
  readonly onRemove: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const textOf = useMessageText();
  const { message } = item;
  const now = useFeedPorts().clock.now();
  return (
    <li className="flex flex-col gap-2 rounded-lg px-3 py-3 hover:bg-surface-100">
      <button type="button" className="flex min-w-0 items-start gap-3 text-left" onClick={onOpen}>
        <Avatar
          name={authorOf(message).displayName}
          username={authorOf(message).username}
          size="sm"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1 text-caption text-ink-muted">
            <span className="font-semibold text-ink">{authorOf(message).displayName}</span>
            <span aria-hidden="true">·</span>
            {channel === undefined ? t('questions.unnamed') : <ChannelName channel={channel} />}
            <time dateTime={item.savedAt} className="ml-auto font-mono text-caption">
              {t('saved.when', { when: format.time(item.savedAt, now) })}
            </time>
          </span>
          <span className="block truncate text-body text-ink">{textOf(message)}</span>
        </span>
      </button>
      <div className="flex flex-wrap gap-2 pl-8">
        {MOVES[item.state].map((to) => (
          <Button
            key={to}
            variant="secondary"
            onClick={() => {
              onMove(to);
            }}
          >
            {t(`saved.move.${to}`)}
          </Button>
        ))}
        <Button variant="ghost" glyph="delete" onClick={onRemove}>
          {t('saved.remove')}
        </Button>
      </div>
    </li>
  );
};

export const SavedScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate, search } = useRoute();
  const api = useApi();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const state = stateIn(search);
  const query = useSaved(workspace.id, state);
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const items = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.data), [query.data]);

  /** Takes the item off this tab at once, asks, and reads every view again either way. */
  const change = (
    item: SavedItem,
    ask: () => Promise<void>,
    failed: 'saved.moveFailed' | 'saved.unsaveFailed',
  ): void => {
    client.setQueryData<InfiniteData<SavedPage>>(pagesKey(workspace.id, state), (data) =>
      data === undefined
        ? data
        : {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              data: page.data.filter((kept) => kept.id !== item.id),
            })),
          },
    );
    ask().then(
      () => {
        void client.invalidateQueries({ queryKey: keys.saved(workspace.id) });
      },
      (failure: unknown) => {
        void client.invalidateQueries({ queryKey: keys.saved(workspace.id) });
        show({ message: `${t(failed)} ${describe(failure)}` });
      },
    );
  };

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus
        label={t('saved.loading')}
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
        title={t('saved.error.title')}
        body={t('saved.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (items.length === 0) {
    body = (
      <section className="flex max-w-feed flex-col items-center gap-3 px-4 text-center">
        <span
          aria-hidden="true"
          className="inline-flex size-avatar-lg items-center justify-center rounded-lg bg-accent-subtle text-accent-text"
        >
          <Icon name="saved" size="lg" />
        </span>
        <h2 className="text-title text-ink">{t(`saved.empty.${state}`)}</h2>
        <p className="text-body text-ink-muted">{t('saved.empty.body')}</p>
      </section>
    );
  } else {
    body = (
      <div className="flex w-full max-w-feed flex-col gap-4 px-3 py-4">
        <ul className="flex flex-col gap-1">
          {items.map((item) => (
            <Row
              key={item.id}
              item={item}
              channel={byId.get(item.message.channelId)}
              onOpen={() => {
                navigate(
                  href('channel', { slug: workspace.slug, channelId: item.message.channelId }),
                );
              }}
              onMove={(to) => {
                change(item, () => api.saveMessage(item.message.id, to), 'saved.moveFailed');
              }}
              onRemove={() => {
                change(item, () => api.unsaveMessage(item.message.id), 'saved.unsaveFailed');
              }}
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
              {t('saved.more')}
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
            <Icon name="saved" size="lg" />
          </HeaderTile>
          <h1 className="whitespace-nowrap text-heading text-ink">{t('saved.title')}</h1>
        </div>
        <div role="group" aria-label={t('saved.tabs')} className="flex gap-1">
          {STATES.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={tab === state}
              className={cn(
                'rounded-md px-3 py-1 text-label',
                tab === state ? 'bg-surface-200 text-ink' : 'text-ink-muted hover:text-ink',
              )}
              onClick={() => {
                navigate(`${href('saved', { slug: workspace.slug })}?state=${tab}`);
              }}
            >
              {t(`saved.tab.${tab}`)}
            </button>
          ))}
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </>
  );
};
