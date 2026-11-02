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
 * One busy thread is one row (D-162, `group.ts`): its replies of one day, gathered under the newest,
 * named by the root's first line. Opening it, or Mark read, reads every reply it gathers.
 *
 * Reading here lowers the channels' mention badges: the server recounts them and tells every
 * device (`CHANNEL_STATE`), so nothing here touches a channel's numbers.
 */
import { useMemo, useState } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { useChannels, useNotifications } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { HeaderTile } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { NavToggle } from '../shell/nav';
import { ListCard, ListColumn, ListFilter } from '../../ui/list-column';
import { useWorkspace } from '../shell/workspace';
import { useSession } from '../session/session';
import {
  INBOX_CATEGORIES,
  categoryIn,
  inboxSearch,
  typesOf,
  type InboxCategory,
} from './categories';
import { groupInbox, type InboxRow } from './group';
import { InboxRowItem } from './inbox-row';
import { useInboxReads } from './read';
import { targetOf } from './why';

/** Whether two instants fall on the same day where the person is. */
const sameDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** One day's notifications, in a card: Today, or Earlier. */
const Section = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <ListCard heading={<h2 className="text-label text-ink-muted">{title}</h2>}>{children}</ListCard>
);

/** What each category is drawn with when it is empty: the glyph its rows carry. */
const CATEGORY_GLYPH = {
  mentions: 'mention',
  direct: 'person',
  threads: 'reply',
} as const satisfies Record<Exclude<InboxCategory, 'all'>, GlyphName>;

export const InboxScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate, search } = useRoute();
  const ports = useFeedPorts();
  const { user: me } = useSession();
  const reads = useInboxReads();
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  // The address is the category's source of truth (D-208): the panel's See all lands on it, a
  // reload keeps it, and Back goes to the one before.
  const category = categoryIn(search);
  const types = typesOf(category);
  const query = useNotifications(
    workspace.id,
    filter === 'unread',
    types === undefined ? undefined : { key: category, types },
  );
  const showCategory = (next: InboxCategory): void => {
    const query = inboxSearch(next);
    const path = href('inbox', { slug: workspace.slug });
    navigate(query === undefined ? path : `${path}?${query}`, { replace: true });
  };
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const all = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.data), [query.data]);
  const now = ports.clock.now();

  /** Reads what waits of a row — every reply it gathers (D-162) — and nothing when none does. */
  const readRow = (row: InboxRow): void => {
    reads.readIds(row.members.filter((n) => n.readAt === null).map((n) => n.id));
  };

  const open = (row: InboxRow): void => {
    readRow(row);
    navigate(targetOf(workspace.slug, row.newest));
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
      ) : category === 'all' ? (
        <GlyphEmptyState
          glyph="notifications"
          tone="success"
          title={t('state.inbox.empty.title')}
          body={t('state.inbox.empty.body')}
        />
      ) : (
        // A category with nothing in it says which, and that the rest is a choice away.
        <GlyphEmptyState
          glyph={CATEGORY_GLYPH[category]}
          tone="success"
          title={t(`inbox.category.empty.${category}`)}
          body={t('inbox.category.empty.body')}
        />
      );
  } else {
    const grouped = groupInbox(all);
    const today = grouped.filter((row) => sameDay(new Date(row.newest.createdAt), now));
    const earlier = grouped.filter((row) => !sameDay(new Date(row.newest.createdAt), now));
    const rows = (list: readonly InboxRow[]): React.JSX.Element[] =>
      list.map((row) => (
        <InboxRowItem
          key={row.key}
          row={row}
          channel={byId.get(row.newest.channelId)}
          me={me.id}
          now={now}
          onOpen={open}
          onRead={readRow}
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
      <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4">
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
              // "Up to the newest" is the whole inbox's; in a category it would also read what the
              // other categories hold, unseen. There, what is read is what is shown.
              if (category === 'all') reads.readAll(newest.id, new Set(all.map((n) => n.id)));
              else reads.readIds(all.filter((n) => n.readAt === null).map((n) => n.id));
            }}
          >
            {t('inbox.readAll')}
          </Button>
        )}
      </header>
      <ListColumn>
        <div className="flex flex-wrap items-center gap-2">
          <ListFilter
            label={t('inbox.category.label')}
            value={category}
            choices={INBOX_CATEGORIES.map((choice) => ({
              value: choice,
              label: t(`inbox.category.${choice}`),
            }))}
            onChange={showCategory}
          />
          <ListFilter
            label={t('inbox.show')}
            value={filter}
            choices={(['all', 'unread'] as const).map((choice) => ({
              value: choice,
              label: t(`inbox.filter.${choice}`),
            }))}
            onChange={setFilter}
          />
        </div>
        {body}
      </ListColumn>
    </>
  );
};
