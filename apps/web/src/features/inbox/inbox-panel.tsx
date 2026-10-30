/**
 * The inbox panel (D-208): what the person was told, at a glance, from the rail — without leaving the
 * conversation they are in. It is a summary, not a second inbox: the newest ten of a category, read
 * from the server as one page (`useNotificationsPanel`), and **See all** to the inbox's page for the
 * rest, landing on the same category.
 *
 * - **Categories** are server queries (D-153, `categories.ts`), so Mentions is every mention.
 * - **No count of its own.** The one numeric badge is a channel's mentions (D-110); the panel draws
 *   unread as the inbox does, a dot and full ink, and says nothing in numbers.
 * - **Reading** is the inbox's (`read.ts`): opening a row reads it, Mark read beside it reads it in
 *   place. Mark all read reads the workspace's inbox up to the newest row when the view is All; in a
 *   category it reads the rows shown, since "up to" would also read what the other categories hold.
 * - **Live, and cheap.** A frame that says the inbox changed reads this one page again while the
 *   panel is open; closed, nothing is asked.
 *
 * Below the narrow breakpoint the rail is inside the navigation's overlay, and a popover over an
 * overlay is one layer too many: there the rail's Inbox is the link to the page it always was.
 */
import * as Popover from '@radix-ui/react-popover';
import { useMemo, useState } from 'react';
import { useChannels, useNotificationsPanel } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { Link, useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { ListFilter } from '../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { Tooltip } from '../../ui/tooltip';
import { useFeedPorts } from '../channel/feed-ports';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { INBOX_CATEGORIES, inboxSearch, typesOf, type InboxCategory } from './categories';
import { groupInbox, type InboxRow } from './group';
import { InboxRowItem } from './inbox-row';
import { useInboxReads } from './read';
import { targetOf } from './why';

interface InboxPanelProps {
  /** The rail's Inbox: the button the panel opens from, and is anchored to. */
  readonly trigger: React.ReactElement;
  /** The trigger's name, for its tip. */
  readonly label: string;
}

const Body = ({
  category,
  onDone,
}: {
  readonly category: InboxCategory;
  /** The panel has done its job — a row was opened, or See all chosen — and closes. */
  readonly onDone: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const { user: me } = useSession();
  const { clock } = useFeedPorts();
  const reads = useInboxReads();
  const types = typesOf(category);
  const query = useNotificationsPanel(
    workspace.id,
    types === undefined ? { key: category } : { key: category, types },
    true,
  );
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const shown = useMemo(() => query.data?.data ?? [], [query.data]);
  const rows = useMemo(() => groupInbox(shown), [shown]);
  const now = clock.now();

  const readRow = (row: InboxRow): void => {
    reads.readIds(row.members.filter((n) => n.readAt === null).map((n) => n.id));
  };
  const open = (row: InboxRow): void => {
    readRow(row);
    onDone();
    navigate(targetOf(workspace.slug, row.newest));
  };

  if (query.isPending) {
    return (
      <LoadingStatus label={t('state.inbox.loading')} className="flex flex-col gap-3 px-4 py-3">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex flex-col gap-2">
            <Skeleton className="w-members" />
            <Skeleton />
          </div>
        ))}
      </LoadingStatus>
    );
  }
  if (query.isError && query.data === undefined) {
    return (
      <div className="px-4 py-3">
        <ErrorState
          title={t('state.inbox.error.title')}
          body={t('state.inbox.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-col gap-1 px-4 py-6 text-center">
        <p className="text-label text-ink">
          {category === 'all'
            ? t('state.inbox.empty.title')
            : t(`inbox.category.empty.${category}`)}
        </p>
        <p className="text-caption text-ink-muted">
          {category === 'all' ? t('state.inbox.empty.body') : t('inbox.category.empty.body')}
        </p>
      </div>
    );
  }
  return (
    <ul
      aria-label={t(`inbox.category.${category}`)}
      className="max-h-inbox-panel-list overflow-y-auto"
    >
      {rows.map((row) => (
        <InboxRowItem
          key={row.key}
          density="panel"
          row={row}
          channel={byId.get(row.newest.channelId)}
          me={me.id}
          now={now}
          onOpen={open}
          onRead={readRow}
        />
      ))}
    </ul>
  );
};

/** Mark all read for the view on screen; drawn only while something in it waits. */
const ReadAll = ({ category }: { readonly category: InboxCategory }): React.JSX.Element | null => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const reads = useInboxReads();
  const types = typesOf(category);
  const query = useNotificationsPanel(
    workspace.id,
    types === undefined ? { key: category } : { key: category, types },
    true,
  );
  const shown = query.data?.data ?? [];
  const waiting = shown.filter((n) => n.readAt === null);
  const newest = shown[0];
  if (newest === undefined || waiting.length === 0) return null;
  return (
    <Button
      variant="ghost"
      glyph="confirm"
      onClick={() => {
        if (category === 'all') reads.readAll(newest.id, new Set(shown.map((n) => n.id)));
        else reads.readIds(waiting.map((n) => n.id));
      }}
    >
      {t('inbox.readAll')}
    </Button>
  );
};

export const InboxPanel = ({ trigger, label }: InboxPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  // Kept while the panel is closed: opened again, it shows the category it was left on.
  const [category, setCategory] = useState<InboxCategory>('all');
  const done = (): void => {
    setOpen(false);
  };
  const seeAll = inboxSearch(category);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip content={label} side="right">
        <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          aria-label={t('inbox.panel.label')}
          className="z-popover flex w-inbox-panel flex-col overflow-hidden rounded-2xl border-hairline border-border-subtle bg-surface-100 shadow-float data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out"
        >
          <div className="flex items-center gap-2 px-4 pt-3 pb-2">
            <h2 className="flex-1 text-title text-ink">{t('inbox.title')}</h2>
            {open && <ReadAll category={category} />}
          </div>
          <div className="px-4 pb-2">
            <ListFilter
              label={t('inbox.category.label')}
              value={category}
              choices={INBOX_CATEGORIES.map((choice) => ({
                value: choice,
                label: t(`inbox.category.${choice}`),
              }))}
              onChange={setCategory}
            />
          </div>
          <div className="border-t-hairline border-border-subtle">
            {open && <Body category={category} onDone={done} />}
          </div>
          <Link
            to="inbox"
            params={{ slug: workspace.slug }}
            {...(seeAll === undefined ? {} : { search: seeAll })}
            onClick={done}
            className="flex h-control items-center justify-center border-t-hairline border-border-subtle text-label font-medium text-accent-text transition-colors duration-hover ease-standard hover:bg-surface-050 max-narrow:h-touch"
          >
            {t('inbox.panel.seeAll')}
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
};
