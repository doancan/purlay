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
import { href, messageHref } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { useToast } from '../../ui/toast';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { NavToggle } from '../shell/nav';
import { ListCard, ListColumn, listButtonClasses, listRowClasses } from '../../ui/list-column';
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
    <li className={cn('group relative', listRowClasses)}>
      <button type="button" className={listButtonClasses('pr-5')} onClick={onOpen}>
        <Avatar
          name={authorOf(message, t('user.erased')).displayName}
          username={authorOf(message, t('user.erased')).username}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-baseline gap-2 whitespace-nowrap text-label text-ink-muted">
            <span className="min-w-0 truncate font-semibold text-ink">
              {authorOf(message, t('user.erased')).displayName}
            </span>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate">
              {channel === undefined ? t('questions.unnamed') : <ChannelName channel={channel} />}
            </span>
            <time dateTime={item.savedAt} className="ml-auto shrink-0 font-mono text-caption">
              {t('saved.when', { when: format.time(item.savedAt, now) })}
            </time>
          </span>
          <span className="line-clamp-2 block text-body text-ink">{textOf(message)}</span>
        </span>
      </button>
      {/* Beside the row, not inside its button: each its own control. On a pointer they appear with
          the row's hover or a keyboard's focus, over the row's meta line and in its hover tone, so they
          read as the row's own; on a phone, where nothing hovers, they stay below the words. */}
      <div className="absolute top-1 right-3 flex gap-1 bg-surface-050 pl-2 opacity-0 transition-opacity duration-hover ease-standard group-hover:opacity-100 focus-within:opacity-100 max-narrow:static max-narrow:flex-wrap max-narrow:bg-transparent max-narrow:px-3 max-narrow:pt-0 max-narrow:pb-3 max-narrow:opacity-100">
        {MOVES[item.state].map((to) => (
          <Button
            key={to}
            variant="ghost"
            onClick={() => {
              onMove(to);
            }}
          >
            {t(`saved.move.${to}`)}
          </Button>
        ))}
        <Button
          variant="dangerQuiet"
          glyph="delete"
          aria-label={t('saved.remove')}
          onClick={onRemove}
        >
          {/* A phone's row has room for the short word beside Complete and Archive. */}
          <span className="max-narrow:hidden">{t('saved.remove')}</span>
          <span className="hidden max-narrow:inline">{t('saved.removeShort')}</span>
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
      <LoadingStatus label={t('saved.loading')} className="flex flex-col gap-4 py-2">
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
      <GlyphEmptyState
        glyph="saved"
        tone="accent"
        title={t(`saved.empty.${state}`)}
        body={t('saved.empty.body')}
      />
    );
  } else {
    body = (
      <>
        <ListCard label={t('saved.title')}>
          {items.map((item) => (
            <Row
              key={item.id}
              item={item}
              channel={byId.get(item.message.channelId)}
              onOpen={() => {
                navigate(messageHref(workspace.slug, item.message.channelId, item.message.id));
              }}
              onMove={(to) => {
                change(item, () => api.saveMessage(item.message.id, to), 'saved.moveFailed');
              }}
              onRemove={() => {
                change(item, () => api.unsaveMessage(item.message.id), 'saved.unsaveFailed');
              }}
            />
          ))}
        </ListCard>
        {query.hasNextPage && (
          <div className="flex justify-center">
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
      </>
    );
  }

  return (
    <>
      {/* On a phone the tabs take a row of their own: beside the title they were drawn over it (#681). */}
      <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-5 max-narrow:h-auto max-narrow:flex-wrap max-narrow:py-2">
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <HeaderTile>
            <Icon name="saved" size="lg" />
          </HeaderTile>
          <h1 className="whitespace-nowrap text-heading text-ink">{t('saved.title')}</h1>
        </div>
        <div role="group" aria-label={t('saved.tabs')} className="flex gap-1 max-narrow:w-full">
          {STATES.map((tab) => (
            <button
              key={tab}
              type="button"
              aria-pressed={tab === state}
              className={cn(
                'rounded-md px-3 py-1 text-label max-narrow:h-touch max-narrow:flex-1',
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
      <ListColumn>{body}</ListColumn>
    </>
  );
};
