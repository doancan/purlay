/**
 * The Updates section of the inbox (D-286): what the modules the server runs told the person, in a list of its own beside
 * the conversations' notifications and never merged into them (D-283 §8.3) — the two are different things with different
 * rules (a notification is bound to a message and a channel; an update is a module's short sentence about its own subject).
 *
 * A kind this page knows (`notices` in a running module's manifest) is said in the person's language and opens its place; a
 * kind it does not know — a newer server's — is said plainly by the module's name and opens nothing, so it never breaks the
 * page. Reading is painted at once and then asked, and refused, the list is read again and the toast says why.
 *
 * This file is its own chunk where the shell reaches for it (the panel), so the shell carries the dot and none of the list.
 */
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type UseInfiniteQueryResult,
} from '@tanstack/react-query';
import { PAGE_LIMIT, type InboxEntry, type InboxPage } from '@purlay/types';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useMembers } from '../../../data/queries';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { noticesOf } from '../../../modules/registry';
import { useRoute } from '../../../router/router-provider';
import { Avatar } from '../../../ui/avatar';
import { Button } from '../../../ui/button';
import { useToast } from '../../../ui/toast';
import { cn } from '../../../ui/cn';
import { ListCard, listButtonClasses, listRowClasses } from '../../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../../ui/states';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { useFeedPorts } from '../channel/feed-ports';

type Cached = InboxPage | InfiniteData<InboxPage>;

/** Reads these in every cached view of the workspace's updates; `'all'` reads every one, and the count falls with them. */
const paintRead = (
  client: QueryClient,
  workspaceId: string,
  ids: readonly string[] | 'all',
  at: string,
): void => {
  const waiting = new Set(ids === 'all' ? [] : ids);
  const readIn = (page: InboxPage): InboxPage => ({
    ...page,
    data: page.data.map((entry) =>
      entry.readAt === null && (ids === 'all' || waiting.has(entry.id))
        ? { ...entry, readAt: at }
        : entry,
    ),
    unreadCount: ids === 'all' ? 0 : Math.max(0, page.unreadCount - waiting.size),
  });
  client.setQueriesData<Cached>({ queryKey: keys.inbox(workspaceId) }, (data) =>
    data === undefined
      ? data
      : 'pages' in data
        ? { ...data, pages: data.pages.map(readIn) }
        : readIn(data),
  );
};

/** The caller's updates in the workspace, newest first, `limit` a page (the panel's glance is one short page). */
const useUpdates = (limit?: number): UseInfiniteQueryResult<InfiniteData<InboxPage>> => {
  const api = useApi();
  const { workspace } = useWorkspace();
  return useInfiniteQuery({
    queryKey: [...keys.inbox(workspace.id), 'list', limit ?? 'page'],
    queryFn: ({ pageParam, signal }) =>
      api.inbox(
        workspace.id,
        {
          ...(pageParam === undefined ? {} : { before: pageParam }),
          ...(limit === undefined ? {} : { limit }),
        },
        signal,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
};

const useReadUpdates = (): {
  readonly readIds: (ids: readonly string[]) => void;
  readonly readAll: () => void;
} => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { clock } = useFeedPorts();
  const { show } = useToast();
  const read = (ids: readonly string[] | 'all', ask: () => Promise<void>): void => {
    // What is on its way must not land on top of the paint: cancelled before it, in the same breath.
    void client.cancelQueries({ queryKey: keys.inbox(workspace.id) });
    paintRead(client, workspace.id, ids, clock.now().toISOString());
    ask().then(
      () => client.invalidateQueries({ queryKey: keys.inbox(workspace.id) }),
      (failure: unknown) => {
        void client.invalidateQueries({ queryKey: keys.inbox(workspace.id) });
        show({ message: `${t('inbox.readFailed')} ${describe(failure)}` });
      },
    );
  };
  return {
    readIds: (ids): void => {
      for (let at = 0; at < ids.length; at += PAGE_LIMIT.max) {
        const chunk = ids.slice(at, at + PAGE_LIMIT.max);
        read(chunk, () => api.readInbox(workspace.id, { ids: chunk }));
      }
    },
    readAll: (): void => {
      read('all', () => api.readInbox(workspace.id, { all: true }));
    },
  };
};

/** Mark all read for the updates on screen; drawn only while one waits. */
export const UpdatesReadAll = ({
  limit,
}: {
  readonly limit?: number;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const { readAll } = useReadUpdates();
  const first = useUpdates(limit).data?.pages[0];
  if (first === undefined || first.unreadCount === 0) return null;
  return (
    <Button variant="ghost" glyph="confirm" onClick={readAll}>
      {t('inbox.readAll')}
    </Button>
  );
};

const UpdateRow = ({
  entry,
  density,
  onDone,
}: {
  readonly entry: InboxEntry;
  readonly density: 'page' | 'panel';
  readonly onDone: () => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const { modules } = useSession();
  const { clock } = useFeedPorts();
  const { readIds } = useReadUpdates();
  const members = useMembers(workspace.id).data;
  const actor = members?.find((member) => member.user.id === entry.actorId)?.user;
  const name = actor?.displayName ?? t('user.erased');
  const notice = noticesOf(modules)[entry.kind];
  const unread = entry.readAt === null;
  const sentence =
    notice === undefined
      ? t('inbox.updates.unknown', { name: entry.module })
      : t(notice.words, { name });
  return (
    <li className={cn('group relative', listRowClasses)}>
      <button
        type="button"
        onClick={() => {
          if (unread) readIds([entry.id]);
          if (notice === undefined) return;
          onDone();
          navigate(`/w/${workspace.slug}/${notice.path}`);
        }}
        className={listButtonClasses(
          density === 'panel' ? 'gap-2.5 px-4 py-2.5 max-narrow:px-4' : undefined,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            density === 'panel' ? 'absolute top-4 left-1' : 'absolute top-5 left-2',
            'size-dot rounded-pill',
            unread ? 'bg-accent' : 'bg-transparent',
          )}
        />
        <Avatar
          name={name}
          username={actor?.username ?? name}
          {...(density === 'panel' ? { size: 'sm' as const } : {})}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 whitespace-nowrap text-label text-ink-muted">
            <Icon name="notifications" size="sm" />
            <span className={cn('min-w-0 truncate', unread && 'font-semibold text-ink')}>
              {unread ? <VisuallyHidden>{`${t('sidebar.unread')} `}</VisuallyHidden> : null}
              {sentence}
            </span>
            <time dateTime={entry.createdAt} className="ml-auto shrink-0 font-mono text-caption">
              {format.time(entry.createdAt, clock.now())}
            </time>
          </span>
        </span>
      </button>
    </li>
  );
};

/** The updates, in the states every list has: loading, failed, empty, and the rows with the next page behind a button. */
export const Updates = ({
  density = 'page',
  limit,
  onDone = (): void => undefined,
}: {
  readonly density?: 'page' | 'panel';
  readonly limit?: number;
  readonly onDone?: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const query = useUpdates(limit);
  const rows = (query.data?.pages ?? []).flatMap((page) => page.data);
  if (query.isPending) {
    return (
      <LoadingStatus label={t('state.inbox.loading')} className="flex flex-col gap-3 px-4 py-3">
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} />
        ))}
      </LoadingStatus>
    );
  }
  if (query.isError && query.data === undefined) {
    return (
      <ErrorState
        title={t('state.inbox.error.title')}
        body={t('state.inbox.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (rows.length === 0) {
    return (
      <GlyphEmptyState
        glyph="notifications"
        tone="success"
        title={t('inbox.updates.empty.title')}
        body={t('inbox.updates.empty.body')}
      />
    );
  }
  const items = rows.map((entry) => (
    <UpdateRow key={entry.id} entry={entry} density={density} onDone={onDone} />
  ));
  return (
    <>
      {density === 'page' ? (
        <ListCard label={t('inbox.category.updates')}>{items}</ListCard>
      ) : (
        <ul
          aria-label={t('inbox.category.updates')}
          className="max-h-inbox-panel-list overflow-y-auto"
        >
          {items}
        </ul>
      )}
      {query.hasNextPage && density === 'page' && (
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
    </>
  );
};
