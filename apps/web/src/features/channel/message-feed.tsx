/**
 * A channel's messages: loading, empty, failed, and the feed itself (`UX.md` §3, §6–§8).
 *
 * This component is the glue. The rules live in functions it calls — `buildFeed` decides what
 * is shown and where, `useFeedScroll` where the reader stands, `useMarkRead` when the
 * channel counts as read — each tested on its own; what is left here is arranging them and
 * the keyboard.
 *
 * **Never move content under the reader** (`UX.md` §1): the row at the top is a constant
 * height whether it says "loading older", "the beginning" or nothing, so the status of the
 * load above does not push what is below it; older pages restore the reader's place exactly;
 * and a message arriving while the reader is scrolled up raises a pill instead of moving them.
 *
 * **Keyboard**: one row is in the tab order (roving focus) and ↑ ↓ Home End move between
 * rows; Escape returns to the composer — or, from inside an open thread, folds the thread
 * first (`features/threads`, which also owns T, R and ⌘⇧R on the focused row). Visible focus is the global ring, which a row never
 * hides.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { User } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useMembers, useMessages, readingOrder } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useEngine, usePending } from '../../realtime/realtime-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { EmptyState, ErrorState } from '../../ui/states';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { ThreadsProvider, useThreads } from '../threads/thread-context';
import { ThreadedMessageRow } from '../threads/threaded-row';
import { buildFeed, newestConfirmedId, type FeedItem } from './feed-model';
import { useFeedPorts, type FeedPorts } from './feed-ports';
import { useFeedScroll } from './use-feed-scroll';
import { useMarkRead } from './use-mark-read';

const MINUTE_MS = 60_000;

const floorMinute = (date: Date): number => Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS;

/** The current minute, ticking on the minute: a row's "12m ago" is right without a timer per row. */
const useNowMinute = (ports: FeedPorts): number => {
  const [now, setNow] = useState(() => floorMinute(ports.clock.now()));
  useEffect(() => {
    let cancel = (): void => undefined;
    const tick = (): void => {
      setNow(floorMinute(ports.clock.now()));
      cancel = ports.schedule(tick, MINUTE_MS);
    };
    cancel = ports.schedule(tick, MINUTE_MS - (ports.clock.now().getTime() % MINUTE_MS));
    return (): void => {
      cancel();
    };
  }, [ports]);
  return now;
};

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

/**
 * The channel's composer, wherever the screen put it: the text box in this region that is for
 * writing *to the channel*. A thread has a reply box of its own, earlier in the document than the
 * channel's, and Esc "to the composer" must not land in it (found in a browser: with a thread open,
 * Esc moved focus into its reply box).
 */
const composerIn = (region: Element | null): HTMLElement | null => {
  const outsideThreads = (candidates: Iterable<HTMLElement>): HTMLElement | undefined =>
    Array.from(candidates).find((box) => box.closest('[data-thread-root]') === null);
  return (
    outsideThreads(region?.querySelectorAll<HTMLElement>('[data-composer]') ?? []) ??
    outsideThreads(region?.querySelectorAll<HTMLElement>('textarea') ?? []) ??
    null
  );
};

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.matches('input, textarea, select') || target.isContentEditable);

interface FeedListProps {
  readonly content: React.RefObject<HTMLDivElement | null>;
  readonly scroller: React.RefObject<HTMLDivElement | null>;
  readonly items: readonly FeedItem[];
  readonly channelName: string;
  readonly ariaLabel: string;
  readonly busy: boolean;
  readonly meId: string;
  readonly nowMinute: number;
  readonly members: ReadonlyMap<string, string>;
  /** The one row in the tab order. */
  readonly tabbable: string | null;
  readonly onRetry: (id: string) => void;
  readonly onDiscard: (id: string) => void;
  readonly onFocusRow: (id: string) => void;
}

/**
 * The stream itself, and the keyboard that moves through it. It is its own component so it
 * can sit *inside* the threads' provider and ask it first what a key means (T, R, ⌘⇧R, and
 * Escape from within an open thread) before the feed's own keys get it.
 */
const FeedList = ({
  content,
  scroller,
  items,
  channelName,
  ariaLabel,
  busy,
  meId,
  nowMinute,
  members,
  tabbable,
  onRetry,
  onDiscard,
  onFocusRow,
}: FeedListProps): React.JSX.Element => {
  const { t } = useI18n();
  const threads = useThreads();

  const rows = (): HTMLElement[] =>
    Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-message-row]') ?? []);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Menus and their items render in a portal but bubble here through React; they are not ours.
    if (event.defaultPrevented || !scroller.current?.contains(event.target as Node)) return;
    if (threads.handleKey(event)) return;
    if (event.key === 'Escape') {
      composerIn(scroller.current.closest('main'))?.focus();
      return;
    }
    if (isTypingTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
    const all = rows();
    const current = all.findIndex(
      (row) => row === (event.target as HTMLElement).closest('[data-message-row]'),
    );
    let next = -1;
    if (event.key === 'ArrowUp') next = current === -1 ? all.length - 1 : Math.max(0, current - 1);
    else if (event.key === 'ArrowDown')
      next = current === -1 ? 0 : Math.min(all.length - 1, current + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = all.length - 1;
    const row = all[next];
    if (row === undefined) return;
    event.preventDefault();
    row.focus();
  };

  const onFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-message-id]')?.dataset[
      'messageId'
    ];
    if (id !== undefined) onFocusRow(id);
  };

  return (
    /* A feed is an ordered stream of articles, and a screen reader needs to know it is one. */
    <div
      ref={content}
      role="feed"
      className="mx-auto max-w-feed px-4"
      aria-label={ariaLabel}
      aria-busy={busy}
      onKeyDown={onKeyDown}
      onFocusCapture={onFocus}
    >
      {items.map((item) => {
        if (item.kind === 'day') {
          return (
            <div key={item.key} aria-hidden="true" className="flex justify-center pb-2 pt-4">
              <span className="rounded-pill bg-surface-200 px-3 py-1 text-caption text-ink-muted">
                {item.label}
              </span>
            </div>
          );
        }
        if (item.kind === 'marker') {
          return (
            <div
              key={item.key}
              data-feed-marker=""
              className="flex items-center gap-3 px-2 pb-1 pt-3 text-label"
            >
              <span className="shrink-0 rounded-pill bg-accent px-2 text-on-accent">
                {t('message.newMarker')}
              </span>
              <span className="flex-1 border-t-hairline border-accent" />
            </div>
          );
        }
        return (
          <ThreadedMessageRow
            key={item.key}
            message={item.message}
            delivery={item.delivery}
            failure={item.failure}
            grouped={item.grouped}
            channelName={channelName}
            meId={meId}
            nowMinute={nowMinute}
            members={members}
            tabIndex={item.key === tabbable ? 0 : -1}
            onRetry={onRetry}
            onDiscard={onDiscard}
          />
        );
      })}
    </div>
  );
};

/**
 * How many pages back the feed will read to find the reader's place before opening where it
 * is. Ten pages is five hundred messages: a place older than that is not a place the reader is
 * coming back to, and the cost of finding it is a wait they would notice.
 */
export const SEEK_LIMIT_PAGES = 10;

export interface MessageFeedProps {
  readonly channelId: string;
  readonly channelName: string;
  /**
   * The read position when the channel was opened, frozen by the screen for as long as it
   * stays open; `undefined` when there was nothing unread to mark.
   */
  readonly markerAfter: string | null | undefined;
  /** The read position when the channel was opened, whether or not anything was unread. */
  readonly readAtOpen: string | null;
  /** Only members have a read position to move. */
  readonly member: boolean;
  /** A thread to open with the channel, from the address (`?thread=`); brought into view once loaded. */
  readonly openThread?: string | null;
}

export const MessageFeed = ({
  channelId,
  channelName,
  markerAfter,
  readAtOpen,
  member,
  openThread = null,
}: MessageFeedProps): React.JSX.Element => {
  const { t, format } = useI18n();
  const ports = useFeedPorts();
  const engine = useEngine();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const feed = useMessages(channelId);
  const membersQuery = useMembers(workspace.id);
  const pendingAll = usePending();
  const nowMinute = useNowMinute(ports);

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const top = useRef<HTMLDivElement>(null);
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
  const pending = useMemo(
    () => pendingAll.filter((p) => p.channelId === channelId && p.parentId === null),
    [pendingAll, channelId],
  );
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

  // **A channel opens where the reader's place is, so the place has to be in hand first.** The
  // read position may be older than everything the first page holds (ninety unread in a page of
  // fifty); the marker would then sit above the oldest *loaded* message, the reader would be
  // placed there, and the pages that arrive above would carry them nowhere near the real line
  // (found in a browser, in a channel with two hundred messages and the position at the 120th).
  // Until the position is inside what is loaded — or the reader has been placed once, or the
  // search has gone `SEEK_LIMIT_PAGES` back — older pages are read and the feed is not shown.
  const placed = useRef(false);
  const behind =
    typeof markerAfter === 'string' &&
    messages.length > 0 &&
    !messages.some((m) => m.id <= markerAfter);
  const seeking =
    !placed.current &&
    behind &&
    feed.hasNextPage &&
    (feed.data?.pages.length ?? 0) < SEEK_LIMIT_PAGES;
  useEffect(() => {
    if (feed.isSuccess && !seeking) placed.current = true;
  }, [feed.isSuccess, seeking]);
  // "Never read anything" means the marker is above the oldest message — which is only
  // the oldest *loaded* one until the first page reaches the beginning.
  const marker = seeking || (markerAfter === null && feed.hasNextPage) ? undefined : markerAfter;
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
  const tabbable = useMemo(
    () =>
      focusedId !== null && items.some((i) => i.kind === 'message' && i.key === focusedId)
        ? focusedId
        : lastRowId,
    [focusedId, items, lastRowId],
  );

  const ready = feed.isSuccess && !seeking;
  const { atBottom, newBelow, onScroll, jumpToBottom, holdPlace } = useFeedScroll({
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
    newestId,
    atBottom,
    ports,
  });
  const announcement = useDeliveryAnnouncer(items);

  // Older pages load when the top comes into view, one at a time.
  //
  // **A page that failed is not asked for again by itself.** The observer reports "visible"
  // whenever it is set up and the top row is on screen, and a failed fetch ends the fetching
  // state, which sets it up anew: without the error check one outage was a loop of requests
  // with no back-off, hammering the server while the row said "Try again". Only that button
  // asks after a failure.
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = feed;
  useEffect(() => {
    const root = scroller.current;
    const target = top.current;
    if (!ready || root === null || target === null || !hasNextPage || isFetchNextPageError) {
      return undefined;
    }
    return ports.whenVisible(target, root, () => {
      if (!isFetchingNextPage) void fetchNextPage();
    });
  }, [ready, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, ports]);

  // Reading back to the reader's place (see `seeking`), one page at a time.
  // The count of pages is a dependency because a page that arrives before the render that would
  // have shown `isFetchingNextPage` leaves every other dependency as it was.
  const pagesLoaded = feed.data?.pages.length ?? 0;
  useEffect(() => {
    if (seeking && !isFetchingNextPage) void fetchNextPage();
  }, [seeking, isFetchingNextPage, fetchNextPage, pagesLoaded]);

  // A thread the address asks for may be older than the first page: read back until its root
  // is here or there is nothing older, one page at a time.
  const wanted = openThread !== null && !messages.some((m) => m.id === openThread);
  useEffect(() => {
    if (wanted && ready && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [wanted, ready, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

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
        className="mx-auto flex w-full max-w-feed flex-1 flex-col gap-4 overflow-hidden px-6 py-4"
      >
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex gap-3">
            <span className="size-avatar shrink-0 rounded-pill bg-surface-200" />
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
        <EmptyState title={t('state.feed.empty.title')} body={t('state.feed.empty.body')} />
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
      <div ref={scroller} onScroll={onScroll} className="relative flex-1 overflow-y-auto py-2">
        {/* The top row is one height whatever it says, so loading above never pushes what is below. */}
        <div
          ref={top}
          className="mx-auto flex h-control max-w-feed items-center px-6 text-caption text-ink-muted"
        >
          {feed.isFetchNextPageError ? (
            <span className="flex items-center gap-2 text-danger-text">
              <Icon name="failed" size="sm" />
              {t('feed.olderError')}
              <button type="button" className="underline" onClick={() => void fetchNextPage()}>
                {t('feed.olderRetry')}
              </button>
            </span>
          ) : isFetchingNextPage ? (
            <span role="status">{t('feed.olderLoading')}</span>
          ) : hasNextPage ? null : (
            <span>{t('feed.start')}</span>
          )}
        </div>
        <ThreadsProvider scroller={scroller} holdPlace={holdPlace} openThread={openThread}>
          <FeedList
            content={content}
            scroller={scroller}
            items={items}
            channelName={channelName}
            ariaLabel={t('feed.label', { channel: channelName })}
            busy={isFetchingNextPage}
            meId={user.id}
            nowMinute={nowMinute}
            members={members}
            tabbable={tabbable}
            onRetry={retry}
            onDiscard={discard}
            onFocusRow={setFocusedId}
          />
        </ThreadsProvider>
      </div>

      {newBelow > 0 && !atBottom && (
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
