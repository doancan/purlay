/**
 * A channel's messages: loading, empty, failed, and the feed itself (`UX.md` §3, §6–§8).
 *
 * This component is the glue. The rules live in functions it calls — `buildFeed` decides what
 * is shown and where, `useFeedPlacement` where the channel opens, `useFeedScroll` where the
 * reader stands, `useFeedPaging` which page is read next, `useFeedReveal` what a link brings
 * into view, `useMarkRead` when the channel counts as read, `FeedList` the rows and the
 * keyboard; what is left here is arranging them.
 *
 * **Never move content under the reader** (`UX.md` §1): the row at the top is a constant
 * height whether it says "loading older", "the beginning" or nothing, so the status of the
 * load above does not push what is below it; older pages restore the reader's place exactly;
 * and a message arriving while the reader is scrolled up raises a pill instead of moving them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { measureSwitch } from '../../../app/switch-timing';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { keepNewestPage } from '../../../data/cache';
import { useMembers, useMessages, readingOrder } from '../../../data/queries';
import { useI18n } from '../../../i18n/i18n-provider';
import { useEngine, usePending } from '../../../realtime/realtime-provider';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { EmptyState, ErrorState } from '../../../ui/states';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { buildFeed, newestConfirmedId, type FeedItem } from './feed-model';
import { FeedList } from './feed-list';
import { useFeedPorts } from './feed-ports';
import { useNowMinute } from './now-minute';
import { useFeedPaging } from './use-feed-paging';
import { useFeedPlacement } from './use-feed-placement';
import { useFeedReveal } from './use-feed-reveal';
import { useFeedScroll } from './use-feed-scroll';
import { useMarkRead } from './use-mark-read';

/** Says what happened to a send, to a screen reader, once each time it happens. */
const useDeliveryAnnouncer = (items: readonly FeedItem[]): string => {
  const { t } = useI18n();
  const seen = useRef(new Map<string, string>());
  const [said, setSaid] = useState('');
  useEffect(() => {
    let next = '';
    const present = new Set<string>();
    for (const item of items) {
      if (item.kind !== 'message') continue;
      present.add(item.key);
      const was = seen.current.get(item.key);
      if (was === 'sending' && item.delivery === 'sent') next = t('delivery.announce.sent');
      if (was !== undefined && was !== 'failed' && item.delivery === 'failed') {
        next = t('delivery.announce.failed');
      }
      seen.current.set(item.key, item.delivery);
    }
    for (const key of seen.current.keys()) if (!present.has(key)) seen.current.delete(key);
    if (next !== '') setSaid(next);
  }, [items, t]);
  return said;
};

export interface MessageFeedProps {
  readonly channelId: string;
  readonly channelName: string;
  /** A direct message: its top is the beginning of a conversation, not of a channel. */
  readonly conversation: boolean;
  /**
   * The read position when the channel was opened, frozen by the screen for as long as it
   * stays open; `undefined` when there was nothing unread to mark.
   */
  readonly markerAfter: string | null | undefined;
  /** The read position when the channel was opened, whether or not anything was unread. */
  readonly readAtOpen: string | null;
  /** Only members have a read position to move. */
  readonly member: boolean;
  /** The thread the address opened in the panel (`?thread=`): its root is read back to and brought into view. */
  readonly openThread?: string | null;
  /**
   * The message a link names (`?message=`, D-149): the feed is the window around it, scrolled to it;
   * the message is marked and focused, or a reply's thread opens.
   */
  readonly around?: string | null;
  /** The message a link named is not one the person can read in this channel. */
  readonly onLinkMissing?: (messageId: string) => void;
  /** Back to the present: the channel without the link. */
  readonly onLeaveWindow?: () => void;
}

export const MessageFeed = ({
  channelId,
  channelName,
  conversation,
  markerAfter,
  readAtOpen,
  member,
  openThread = null,
  around = null,
  onLinkMissing,
  onLeaveWindow,
}: MessageFeedProps): React.JSX.Element => {
  const { t, format } = useI18n();
  const ports = useFeedPorts();
  const engine = useEngine();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const feed = useMessages(channelId, around);
  // Leaving the channel lets its older pages go, so coming back draws one page and not everything that
  // was scrolled through (O-5, D-199). Off the switch's critical path: it runs as this feed goes away.
  // **After `useMessages`, and in a synchronous cleanup:** the query's own unsubscribe, which cancels an older
  // page still on its way and puts back the pages from before it, must run first or it undoes the trim.
  const client = useQueryClient();
  useEffect(
    (): (() => void) => () => {
      keepNewestPage(client, channelId);
    },
    [client, channelId],
  );
  const windowed = around !== null;
  // Newer messages than the window holds: it does not reach the present, and nothing arriving is put in it.
  const detached = windowed && feed.hasPreviousPage;
  const membersQuery = useMembers(workspace.id);
  const pendingAll = usePending();
  const nowMinute = useNowMinute(ports);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const me = useMemo<User>(
    () => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    }),
    [user.id, user.username, user.displayName, user.avatarUrl],
  );
  const messages = useMemo(() => readingOrder(feed.data), [feed.data]);
  const pendingHere = useMemo(
    () => pendingAll.filter((p) => p.channelId === channelId && p.parentId === null),
    [pendingAll, channelId],
  );
  // A window short of the present has no bottom to put a send at: the send takes the reader there.
  const pending = useMemo(() => (detached ? [] : pendingHere), [detached, pendingHere]);
  const pendingBefore = useRef(pendingHere.length);
  useEffect(() => {
    if (detached && pendingHere.length > pendingBefore.current) onLeaveWindow?.();
    pendingBefore.current = pendingHere.length;
  }, [detached, pendingHere.length, onLeaveWindow]);
  const members = useMemo(
    () => new Map((membersQuery.data ?? []).map((m) => [m.user.id, m.user.username])),
    [membersQuery.data],
  );
  const today = t('message.today');
  const yesterday = t('message.yesterday');
  const dayLabel = useCallback(
    (iso: string): string => format.day(iso, new Date(nowMinute), { today, yesterday }),
    [format, nowMinute, today, yesterday],
  );

  const { seeking, marker } = useFeedPlacement(feed, messages, markerAfter, windowed);
  const items = useMemo(
    () => buildFeed({ messages, pending, me, markerAfter: marker, dayLabel }),
    [messages, pending, me, marker, dayLabel],
  );
  const newestId = useMemo(() => newestConfirmedId(items), [items]);
  const lastRowId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const item = items[i];
      if (item?.kind === 'message') return item.key;
    }
    return null;
  }, [items]);
  // A switch ends when the new channel's rows are drawn: measured on the frame that shows them (O-5).
  const drawn = lastRowId !== null;
  useEffect(() => {
    if (!drawn) return undefined;
    const frame = requestAnimationFrame(() => {
      measureSwitch(channelId);
    });
    return (): void => {
      cancelAnimationFrame(frame);
    };
  }, [channelId, drawn]);
  const tabbable = useMemo(
    () =>
      focusedId !== null && items.some((i) => i.kind === 'message' && i.key === focusedId)
        ? focusedId
        : lastRowId,
    [focusedId, items, lastRowId],
  );

  const ready = feed.isSuccess && !seeking;
  const { atBottom, newBelow, onScroll, jumpToBottom, holdPlace, extendBelow } = useFeedScroll({
    scroller,
    content,
    items,
    ready,
    meId: user.id,
    ports,
  });
  useMarkRead({
    channelId,
    member,
    readAtOpen: member ? readAtOpen : null,
    // The bottom of a window short of the present is not the channel's: reaching it reads nothing.
    newestId: detached ? null : newestId,
    atBottom,
    ports,
  });
  const announcement = useDeliveryAnnouncer(items);
  const wanted = !windowed && openThread !== null && !messages.some((m) => m.id === openThread);
  const readNewer = useFeedPaging({
    feed,
    scroller,
    top,
    bottom,
    ready,
    seeking,
    wanted,
    extendBelow,
    ports,
  });
  const landed = useFeedReveal({
    feed,
    channelId,
    scroller,
    ready,
    openThread,
    around,
    holdPlace,
    onLinkMissing,
    ports,
  });

  // One function for every row, so a row's props do not change when another row's do.
  const retry = useCallback(
    (id: string): void => {
      engine.retry(id);
    },
    [engine],
  );
  const discard = useCallback(
    (id: string): void => {
      engine.discard(id);
    },
    [engine],
  );

  if (feed.isPending || seeking) {
    return (
      <LoadingStatus
        label={t('state.feed.loading')}
        className="flex w-full flex-1 flex-col gap-4 overflow-hidden px-6 py-4"
      >
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex gap-3">
            <span className="size-avatar-lg shrink-0 rounded-lg bg-surface-200" />
            <div className="flex flex-col gap-2">
              <Skeleton className="w-members" />
              <Skeleton className="w-feed" />
            </div>
          </div>
        ))}
      </LoadingStatus>
    );
  }
  if (feed.isError && feed.data === undefined) {
    return (
      <div className="flex-1">
        <ErrorState
          title={t('state.feed.error.title')}
          body={t('state.feed.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void feed.refetch();
          }}
        />
      </div>
    );
  }
  if (items.length === 0 && !feed.hasNextPage) {
    return (
      <div className="flex-1">
        {/* A conversation has nothing to describe, only its people (#662). */}
        <EmptyState
          title={t('state.feed.empty.title')}
          body={t(conversation ? 'state.feed.empty.conversation' : 'state.feed.empty.body')}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* A refetch that failed behind data already on screen: the rows are the last good ones, and say so. */}
      {feed.isRefetchError && !feed.isFetchNextPageError && (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b-hairline border-border-subtle px-4 py-1 text-caption text-ink-muted"
        >
          <Icon name="warning" size="sm" />
          {t('connection.stale')}
          <button
            type="button"
            className="underline"
            onClick={() => {
              void feed.refetch();
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      )}
      <div
        ref={scroller}
        onScroll={onScroll}
        data-message-list=""
        className="relative flex-1 overflow-y-auto py-2"
      >
        {/* The top row is one height whatever it says, so loading above never pushes what is below. */}
        <div
          ref={top}
          className="flex h-control w-full items-center justify-center px-6 text-caption text-ink-muted"
        >
          {feed.isFetchNextPageError ? (
            <span className="flex items-center gap-2 text-danger-text">
              <Icon name="failed" size="sm" />
              {t('feed.olderError')}
              <button type="button" className="underline" onClick={() => void feed.fetchNextPage()}>
                {t('feed.olderRetry')}
              </button>
            </span>
          ) : feed.isFetchingNextPage ? (
            <span role="status">{t('feed.olderLoading')}</span>
          ) : feed.hasNextPage ? null : (
            <span>{t(conversation ? 'feed.startConversation' : 'feed.start')}</span>
          )}
        </div>
        <FeedList
          content={content}
          scroller={scroller}
          items={items}
          ariaLabel={t('feed.label', { channel: channelName })}
          busy={feed.isFetchingNextPage}
          meId={user.id}
          nowMinute={nowMinute}
          members={members}
          tabbable={tabbable}
          landed={landed}
          onRetry={retry}
          onDiscard={discard}
          onFocusRow={setFocusedId}
        />
        {/* A window's bottom row, one height whatever it says, like the top's (D-149). */}
        {windowed && (
          <div
            ref={bottom}
            className="flex h-control w-full items-center justify-center px-6 text-caption text-ink-muted"
          >
            {feed.isFetchPreviousPageError ? (
              <span className="flex items-center gap-2 text-danger-text">
                <Icon name="failed" size="sm" />
                {t('feed.newerError')}
                <button type="button" className="underline" onClick={readNewer}>
                  {t('feed.olderRetry')}
                </button>
              </span>
            ) : feed.isFetchingPreviousPage ? (
              <span role="status">{t('feed.newerLoading')}</span>
            ) : null}
          </div>
        )}
      </div>

      {detached && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            variant="secondary"
            className="pointer-events-auto shadow-float"
            onClick={() => {
              onLeaveWindow?.();
            }}
          >
            <Icon name="collapse" size="sm" />
            {t('feed.jumpToRecent')}
          </Button>
        </div>
      )}
      {!detached && newBelow > 0 && !atBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            variant="primary"
            className={cn('pointer-events-auto shadow-float')}
            onClick={jumpToBottom}
          >
            <Icon name="collapse" size="sm" />
            {t('message.newMessages', { count: newBelow })}
          </Button>
        </div>
      )}
      <VisuallyHidden>
        <span role="status" aria-live="polite">
          {announcement}
        </span>
      </VisuallyHidden>
    </div>
  );
};
