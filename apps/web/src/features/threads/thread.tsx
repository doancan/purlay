/**
 * The thread panel (`UX.md` §4.2, D-122): one root's thread, on the right of the feed — a header
 * that names it and closes it, the root, the replies under an "N replies" rule, and the box to
 * answer in at the bottom.
 *
 * **Beside the conversation, not instead of it.** On a wide window the panel is a fixed width
 * (`w-thread`) and the feed keeps the rest; below the narrow line (`max-narrow`) there is no room
 * for two columns, so it covers the conversation, and its close control is the way back. It is a
 * labelled complementary region; opening it moves focus in, and closing puts focus back on the
 * root in the feed (`thread-context.tsx`).
 *
 * **The root comes from the feed's cache**, which the feed reads back into for a thread older than
 * its first page (`?thread=`), so the panel shows a skeleton until the root is there and never
 * asks for it twice. **A thread is never rendered half-loaded**: while the replies load there is a
 * skeleton under the root, if they fail there is a Retry with the root intact (§8), and what the
 * person sent but the server has not yet answered is in the list as `sending` or `failed` like any
 * message.
 *
 * A thread that is open but has no replies yet exists for one reason, the person pressed Reply,
 * and it holds the box to write in. A reply arriving near the end keeps the end in view (`UX.md`
 * §6); anywhere else the reader stays where they are.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { Icon } from '../../components/icon';
import { readingOrder, repliesOf, useMembers, useMessages, useThread } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useEngine, usePending } from '../../realtime/realtime-provider';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useFeedPorts } from '../channel/feed-ports';
import { useNowMinute } from '../channel/now-minute';
import { Composer } from '../composer/composer';
import { useEditing } from '../messages/editing';
import { MessageRow } from '../messages/message-row';
import { handleRowKeys } from '../messages/row-keys';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { useOpenThread, useThreads } from './thread-context';
import { THREAD_PANEL_ID, ThreadStatus } from './thread-summary';
import { buildReplies } from './thread-model';

/** A reply arriving this near the end of a thread, or less, keeps the end in view (`UX.md` §6). */
const NEAR_END_PX = 80;

export interface ThreadPanelProps {
  readonly channelId: string;
  /** The channel's name as a person reads it: `#api`, or a person's name for a conversation. */
  readonly channelLabel: string;
  /** The channel's name, for the reply box's label. */
  readonly channelName: string;
}

const ThreadPanelView = ({
  rootId,
  channelId,
  channelLabel,
  channelName,
}: ThreadPanelProps & { readonly rootId: string }): React.JSX.Element | null => {
  const { t } = useI18n();
  const threads = useThreads();
  const { focusRequest } = useOpenThread();
  const engine = useEngine();
  const editing = useEditing();
  const ports = useFeedPorts();
  const nowMinute = useNowMinute(ports);
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const membersQuery = useMembers(workspace.id);
  const pendingAll = usePending();
  const feed = useMessages(channelId);
  const headingId = useId();

  const panel = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const root = useMemo(
    () => readingOrder(feed.data).find((m) => m.id === rootId),
    [feed.data, rootId],
  );
  // The feed reads back older pages until the root is in it (`message-feed.tsx`); when that cannot
  // go on — it failed, or the whole history has no such root — the panel says so instead of loading.
  const rootFailed = feed.isError || feed.isFetchNextPageError;
  const rootGone = feed.isSuccess && !feed.hasNextPage && !feed.isFetching;
  const replyCount = root?.thread?.replyCount ?? 0;
  const resolved = root?.thread?.resolvedAt != null;
  const query = useThread(rootId, root !== undefined && replyCount > 0);
  const replies = useMemo(() => repliesOf(query.data), [query.data]);
  const pending = useMemo(
    () => pendingAll.filter((p) => p.parentId === rootId),
    [pendingAll, rootId],
  );
  const me = useMemo(
    () => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
    }),
    [user.id, user.username, user.displayName, user.avatarUrl],
  );
  const members = useMemo(
    () => new Map((membersQuery.data ?? []).map((m) => [m.user.id, m.user.username])),
    [membersQuery.data],
  );
  const items = useMemo(() => buildReplies({ replies, pending, me }), [replies, pending, me]);

  // ── Focus moves in when the panel opens, to where the person asked ──────
  const { clearFocusRequest } = threads;
  const ready = root !== undefined;
  useEffect(() => {
    if (focusRequest === null || !ready) return;
    if (focusRequest === 'reply') {
      panel.current?.querySelector<HTMLElement>('[data-composer]')?.focus();
    } else {
      heading.current?.focus();
    }
    clearFocusRequest();
  }, [focusRequest, ready, rootId, clearFocusRequest]);

  // ── A reply arriving near the end keeps the end in view ─────────────────
  const lastHeight = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el === null) {
      lastHeight.current = null;
      return;
    }
    const before = lastHeight.current;
    if (before !== null && el.scrollHeight > before) {
      const fromEnd = before - (el.scrollTop + el.clientHeight);
      if (fromEnd <= NEAR_END_PX) el.scrollTop = el.scrollHeight - el.clientHeight;
    }
    lastHeight.current = el.scrollHeight;
  }, [items.length]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    // Menus and their items render in a portal but bubble here through React; they are not ours.
    if (event.defaultPrevented || !panel.current?.contains(event.target as Node)) return;
    if (threads.handleKey(event)) return;
    const rows = Array.from(panel.current.querySelectorAll<HTMLElement>('[data-message-row]'));
    handleRowKeys(event, rows, editing.start);
  };

  const counted = t('thread.replies', { count: replyCount });

  return (
    <aside
      ref={panel}
      id={THREAD_PANEL_ID}
      data-thread-root={rootId}
      aria-labelledby={headingId}
      onKeyDown={onKeyDown}
      className="flex w-thread shrink-0 flex-col border-l-hairline border-border-subtle bg-surface-100 max-narrow:absolute max-narrow:inset-0 max-narrow:z-sticky max-narrow:w-full"
    >
      <div className="flex h-header shrink-0 items-center justify-between gap-2 border-b-hairline border-border-subtle px-4">
        <h2
          ref={heading}
          id={headingId}
          tabIndex={-1}
          className="min-w-0 truncate text-title font-semibold text-ink"
        >
          {t('thread.panel.title')}{' '}
          <span className="font-normal text-ink-muted">{`· ${channelLabel}`}</span>
        </h2>
        <IconButton
          label={t('thread.close')}
          glyph="close"
          shortcut="Esc"
          onClick={() => {
            threads.close();
          }}
        />
      </div>

      {root === undefined && rootFailed ? (
        <div role="alert" className="flex items-center gap-2 p-4 text-label text-danger-text">
          <Icon name="failed" size="sm" />
          {t('thread.rootError')}
          <span aria-hidden="true">·</span>
          <button
            type="button"
            className="underline"
            onClick={() => {
              // No first page: read it again. A first page: go on reading back from where it stopped.
              if (feed.data === undefined) void feed.refetch();
              else void feed.fetchNextPage();
            }}
          >
            {t('common.retry')}
          </button>
        </div>
      ) : root === undefined && rootGone ? (
        <p role="status" className="p-4 text-label text-ink-muted">
          {t('thread.notHere')}
        </p>
      ) : root === undefined ? (
        <LoadingStatus label={t('thread.loading')} className="flex flex-col gap-2 p-4">
          <Skeleton className="w-members" />
          <Skeleton className="w-sidebar" />
        </LoadingStatus>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <MessageRow
            message={root}
            meId={user.id}
            nowMinute={nowMinute}
            members={members}
            dimmed={resolved}
            tabIndex={-1}
          />
          {/* Wraps rather than widening the panel: on a narrow window the button takes a line of its own. */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pt-2">
            {replyCount > 0 && <ThreadStatus root={root} nowMinute={nowMinute} />}
            {replyCount > 0 && (
              <Button
                variant="secondary"
                glyph="resolved"
                onClick={() => {
                  threads.toggleResolution(rootId);
                }}
              >
                {t(resolved ? 'thread.reopen' : 'thread.resolve')}
                <Kbd>⌘⇧R</Kbd>
              </Button>
            )}
          </div>
          <div
            ref={(node) => {
              threads.body.current = node;
            }}
            data-thread-body=""
            className="flex flex-col gap-1"
          >
            <div className="flex items-center py-3 text-caption font-medium text-ink-muted">
              <span className="flex-1 border-t-hairline border-border-subtle" />
              <span className="shrink-0 px-3">{replyCount === 0 ? t('thread.none') : counted}</span>
              <span className="flex-1 border-t-hairline border-border-subtle" />
            </div>

            {replyCount > 0 && query.isPending && (
              <LoadingStatus label={t('thread.loading')} className="flex flex-col gap-2 px-2 py-1">
                <Skeleton className="w-members" />
                <Skeleton className="w-sidebar" />
              </LoadingStatus>
            )}
            {query.isError && query.data === undefined && (
              <div
                role="alert"
                className="flex items-center gap-2 px-2 text-label text-danger-text"
              >
                <Icon name="failed" size="sm" />
                {t('thread.error')}
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    void query.refetch();
                  }}
                >
                  {t('common.retry')}
                </button>
              </div>
            )}

            {items.map((item) => (
              <MessageRow
                key={item.key}
                message={item.message}
                delivery={item.delivery}
                failure={item.failure}
                grouped={item.grouped}
                compact
                meId={user.id}
                nowMinute={nowMinute}
                members={members}
                tabIndex={-1}
                onRetry={engine.retry}
                onDiscard={engine.discard}
              />
            ))}

            {query.hasNextPage && (
              <div className="px-2">
                <Button
                  variant="ghost"
                  busy={query.isFetchingNextPage}
                  onClick={() => {
                    void query.fetchNextPage();
                  }}
                >
                  {t('thread.loadMore')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {root !== undefined && (
        <Composer
          channelId={channelId}
          channelName={t('thread.composerName', { channel: channelName })}
          parentId={rootId}
        />
      )}
    </aside>
  );
};

/** The panel for the thread that is open, or nothing when none is. */
export const ThreadPanel = (props: ThreadPanelProps): React.JSX.Element | null => {
  const { openId } = useOpenThread();
  if (openId === null) return null;
  // Keyed by the root: another thread is another panel, with its own scroll and its own box.
  return <ThreadPanelView key={openId} rootId={openId} {...props} />;
};
