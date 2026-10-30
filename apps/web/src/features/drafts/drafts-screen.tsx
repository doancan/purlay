/**
 * Drafts and sent (D-215): what the person started and has not sent, everywhere in the workspace, and
 * what they sent last — Slack's "Drafts & sent", in the shape the list screens share (D-158).
 *
 * - **Drafts** are this device's, read from where the composers keep them (`listDrafts`): a channel's,
 *   or a thread's. Opening one goes to its composer, which reads it back; deleting one is said with Undo.
 *   A draft written in another tab arrives through the browser's `storage` event.
 * - **Sent** is search narrowed to the person (`senderId`, no words, D-105): the channels they can still
 *   see, newest first, a page at a time — the server's rule for what is visible, not a second one.
 *
 * A draft in a channel the person can no longer see is not listed: its composer is nowhere to open.
 */
import { useInfiniteQuery } from '@tanstack/react-query';
import { useContext, useEffect, useMemo, useState } from 'react';
import type { Channel, Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href, messageHref, threadHref } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import {
  ListCard,
  ListColumn,
  ListFilter,
  listButtonClasses,
  listRowClasses,
} from '../../ui/list-column';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { useToast } from '../../ui/toast';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { ComposerPortsContext, browserPorts } from '../composer/composer-ports';
import { listDrafts, writeDraft, type Draft } from '../composer/drafts';
import { useMessageText } from '../content/github-event';
import { useSession } from '../session/session';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';

const TABS = ['drafts', 'sent'] as const;
type Tab = (typeof TABS)[number];

const Place = ({
  channel,
  thread,
}: {
  readonly channel: Channel;
  readonly thread: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const title = useChannelTitle(channel);
  return (
    <span className="flex items-baseline gap-2 text-label text-ink-muted">
      <span className="min-w-0 truncate font-medium text-ink">{title}</span>
      {thread && <span className="shrink-0">· {t('drafts.inThread')}</span>}
    </span>
  );
};

const DraftRow = ({
  draft,
  channel,
  onOpen,
  onDelete,
}: {
  readonly draft: Draft;
  readonly channel: Channel;
  readonly onOpen: () => void;
  readonly onDelete: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <li className={cn('group relative', listRowClasses)}>
      <button type="button" onClick={onOpen} className={listButtonClasses('flex-col gap-1 pr-14')}>
        <Place channel={channel} thread={draft.parentId !== null} />
        <span className="line-clamp-2 whitespace-pre-wrap text-body text-ink">{draft.text}</span>
      </button>
      <span className="absolute top-2 right-2">
        <IconButton glyph="delete" label={t('drafts.delete')} onClick={onDelete} />
      </span>
    </li>
  );
};

const SentRow = ({
  message,
  channel,
  onOpen,
}: {
  readonly message: Message;
  readonly channel: Channel;
  readonly onOpen: () => void;
}): React.JSX.Element => {
  const { format } = useI18n();
  const textOf = useMessageText();
  const { clock } = useFeedPorts();
  return (
    <li className={listRowClasses}>
      <button type="button" onClick={onOpen} className={listButtonClasses('flex-col gap-1')}>
        <span className="flex w-full items-baseline gap-2">
          <Place channel={channel} thread={message.parentId !== null} />
          <time
            dateTime={message.createdAt}
            className="ml-auto shrink-0 font-mono text-caption text-ink-muted"
          >
            {format.time(message.createdAt, clock.now())}
          </time>
        </span>
        <span className="line-clamp-2 text-body text-ink">{textOf(message)}</span>
      </button>
    </li>
  );
};

const Loading = ({ label }: { readonly label: string }): React.JSX.Element => (
  <LoadingStatus label={label} className="flex flex-col gap-4 py-2">
    {[0, 1, 2].map((row) => (
      <div key={row} className="flex flex-col gap-2">
        <Skeleton className="w-members" />
        <Skeleton className="w-feed" />
      </div>
    ))}
  </LoadingStatus>
);

const Drafts = ({ byId }: { readonly byId: ReadonlyMap<string, Channel> }): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user: me } = useSession();
  const { navigate } = useRoute();
  const { show } = useToast();
  const given = useContext(ComposerPortsContext);
  const storage = useMemo(() => (given ?? browserPorts()).storage, [given]);
  // Read again when a draft changes here or in another tab: storage has no subscription of its own.
  const [, setSeen] = useState(0);
  useEffect(() => {
    const again = (): void => {
      setSeen((n) => n + 1);
    };
    window.addEventListener('storage', again);
    return (): void => {
      window.removeEventListener('storage', again);
    };
  }, []);
  // Read on every render — a handful of entries — so `seen` changing is enough to show what changed.
  const drafts = listDrafts(storage, me.id).filter((draft) => byId.has(draft.channelId));

  if (drafts.length === 0) {
    return (
      <GlyphEmptyState
        glyph="edit"
        tone="success"
        title={t('drafts.empty.title')}
        body={t('drafts.empty.body')}
      />
    );
  }
  return (
    <ListCard>
      {drafts.map((draft) => {
        const channel = byId.get(draft.channelId);
        if (channel === undefined) return null;
        return (
          <DraftRow
            key={draft.key}
            draft={draft}
            channel={channel}
            onOpen={() => {
              navigate(
                draft.parentId === null
                  ? href('channel', { slug: workspace.slug, channelId: draft.channelId })
                  : threadHref(workspace.slug, draft.channelId, draft.parentId),
              );
            }}
            onDelete={() => {
              writeDraft(storage, draft.key, '');
              setSeen((n) => n + 1);
              show({
                message: t('drafts.deleted'),
                actionLabel: t('common.undo'),
                onAction: () => {
                  writeDraft(storage, draft.key, draft.text);
                  setSeen((n) => n + 1);
                },
              });
            }}
          />
        );
      })}
    </ListCard>
  );
};

const Sent = ({ byId }: { readonly byId: ReadonlyMap<string, Channel> }): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user: me } = useSession();
  const { navigate } = useRoute();
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: keys.sent(workspace.id, me.id),
    queryFn: ({ pageParam, signal }) =>
      api.search(workspace.id, { q: '', senderId: me.id, before: pageParam }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const messages = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.data),
    [query.data],
  );

  if (query.isPending) return <Loading label={t('drafts.sent.loading')} />;
  if (query.isError && query.data === undefined) {
    return (
      <ErrorState
        title={t('drafts.sent.error.title')}
        body={t('drafts.sent.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (messages.length === 0) {
    return (
      <GlyphEmptyState
        glyph="send"
        tone="success"
        title={t('drafts.sent.empty.title')}
        body={t('drafts.sent.empty.body')}
      />
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <ListCard>
        {messages.map((message) => {
          const channel = byId.get(message.channelId);
          if (channel === undefined) return null;
          return (
            <SentRow
              key={message.id}
              message={message}
              channel={channel}
              onOpen={() => {
                navigate(
                  message.parentId === null
                    ? messageHref(workspace.slug, message.channelId, message.id)
                    : threadHref(workspace.slug, message.channelId, message.parentId),
                );
              }}
            />
          );
        })}
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
            {t('drafts.sent.more')}
          </Button>
        </div>
      )}
    </div>
  );
};

export const DraftsScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const [tab, setTab] = useState<Tab>('drafts');
  return (
    <>
      <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4">
        <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
          <NavToggle />
          <HeaderTile>
            <Icon name="edit" size="lg" />
          </HeaderTile>
          <h1 className="whitespace-nowrap text-heading text-ink">{t('drafts.title')}</h1>
        </div>
      </header>
      <ListColumn>
        <ListFilter
          label={t('drafts.tabs')}
          value={tab}
          choices={TABS.map((choice) => ({ value: choice, label: t(`drafts.tab.${choice}`) }))}
          onChange={setTab}
        />
        {channels.isPending ? (
          <Loading label={t('drafts.loading')} />
        ) : tab === 'drafts' ? (
          <Drafts byId={byId} />
        ) : (
          <Sent byId={byId} />
        )}
      </ListColumn>
    </>
  );
};
