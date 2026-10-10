/**
 * A root's thread, in place under it (`UX.md` §4, D-98): the line that says where it stands,
 * and — when it is open — its replies and the box to answer in.
 *
 * **There is no drawer.** A conversation in a side panel is a footnote, which is how
 * knowledge gets lost (`UX.md` §1); it expands under the message it belongs to, indented and
 * rule-marked so its boundary is unmistakable while scrolling.
 *
 * **A root nobody has replied to has no thread affordance at all** — an empty control on
 * every message is clutter that teaches people to ignore that region (§4.1) — and a reply
 * never has one: depth is two levels (I-1), so the limit is not something a person can bump
 * into. A thread that is *open* but has no replies yet exists for one reason, the person
 * pressed Reply, and it holds the box to write in.
 *
 * **A thread is never rendered empty or half-loaded**: while its replies load there is an
 * inline skeleton under the root, if they fail there is an inline Retry with the root
 * intact (§8), and what the person sent but the server has not yet answered is in the list
 * as `sending` or `failed` like any message.
 *
 * Resolving collapses it with the product's one animation (`collapse.ts`), and the line
 * becomes "Resolved by …" with the root's text dimmed — the feed gets quieter as questions
 * close (`ThreadedMessageRow`). Nothing is posted: the resolution is metadata on the root.
 */
import { useDescribeFailure } from '../../data/failure';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { repliesOf, useThread } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useEngine, usePending } from '../../realtime/realtime-provider';
import { Button } from '../../ui/button';
import { Kbd } from '../../ui/kbd';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { Composer } from '../composer/composer';
import { MessageRow } from '../messages/message-row';
import { useSession } from '../session/session';
import { foldAway } from './collapse';
import { useThreadView, useThreads } from './thread-context';
import { buildReplies } from './thread-model';

/** A reply arriving this near the end of a thread, or less, keeps the end in view (`UX.md` §6). */
const NEAR_END_PX = 80;

export interface ThreadProps {
  readonly root: Message;
  readonly channelName: string;
  readonly meId: string;
  readonly nowMinute: number;
  readonly members: ReadonlyMap<string, string>;
}

const ThreadView = ({
  root,
  channelName,
  meId,
  nowMinute,
  members,
}: ThreadProps): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const describe = useDescribeFailure();
  const threads = useThreads();
  const actions = useActions();
  const engine = useEngine();
  const toast = useToast();
  const { user } = useSession();
  const pendingAll = usePending();

  const summary = root.thread;
  const replyCount = summary?.replyCount ?? 0;
  const resolved = summary?.resolvedAt != null;
  const { expanded, replyRequested } = useThreadView(root.id);

  const section = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  // Held across renders so a keypress and a click that race are one resolution, and so the
  // cross-device collapse below can tell its own action from somebody else's.
  const working = useRef(false);

  const query = useThread(root.id, expanded);
  const replies = useMemo(() => repliesOf(query.data), [query.data]);
  const pending = useMemo(
    () => pendingAll.filter((p) => p.parentId === root.id),
    [pendingAll, root.id],
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
  const items = useMemo(() => buildReplies({ replies, pending, me }), [replies, pending, me]);

  const counted = t('thread.replies', { count: replyCount });

  // ── Resolve / reopen ────────────────────────────────────────────────────
  const latest = useRef<{ replyCount: number; toggle: () => void }>({
    replyCount,
    toggle: () => undefined,
  });
  const toggleResolution = useCallback((): void => {
    if (working.current || replyCount === 0) return;
    working.current = true;
    setBusy(true);
    void (async (): Promise<void> => {
      try {
        if (resolved) {
          await actions.reopen(root);
          setSaid(t('thread.announce.reopened'));
        } else {
          await actions.resolve(root);
          setSaid(t('thread.announce.resolved'));
          // The one animated thing: fold the open thread away, then leave it collapsed.
          if (expanded && body.current !== null) await foldAway(body.current);
          threads.collapse(root.id);
        }
      } catch (error) {
        toast.show({
          message:
            isApiError(error) && error.code === 'THREAD_NOT_RESOLVABLE'
              ? t('thread.resolveFailed')
              : `${t('thread.actionFailed')} ${describe(error)}`,
        });
      } finally {
        working.current = false;
        setBusy(false);
      }
    })();
  }, [replyCount, resolved, expanded, actions, root, t, threads, toast]);
  latest.current = { replyCount, toggle: toggleResolution };

  // What the keyboard may do to this thread, read fresh each time it is asked.
  const { register } = threads;
  useEffect(
    () =>
      register(root.id, {
        hasReplies: () => latest.current.replyCount > 0,
        toggleResolution: () => {
          latest.current.toggle();
        },
      }),
    [register, root.id],
  );

  // Resolved somewhere else while this is open: fold it without ceremony — nothing here
  // asked for it, so nothing here should animate at the reader.
  const wasResolved = useRef(resolved);
  useEffect(() => {
    if (resolved && !wasResolved.current && expanded && !working.current) {
      threads.collapse(root.id);
    }
    wasResolved.current = resolved;
  }, [resolved, expanded, threads, root.id]);

  // ── The reply box, when somebody asked for it ───────────────────────────
  const { clearReplyRequest } = threads;
  useEffect(() => {
    if (!replyRequested || !expanded) return;
    section.current?.querySelector<HTMLElement>('[data-composer]')?.focus();
    clearReplyRequest();
  }, [replyRequested, expanded, clearReplyRequest]);

  // ── A reply arriving near the end keeps the end in view ─────────────────
  // Measured in the scroller's own coordinates (where the end *is in the content*), not on the
  // screen: on the screen the end moves whenever the reader does, and a reader carried from the
  // bottom of the channel to this thread by a link would read as a thread that grew by the whole
  // distance (found in a browser: the page was dragged straight back down).
  const lastEnd = useRef<number | null>(null);
  useLayoutEffect(() => {
    const marker = end.current;
    const scroller = threads.scroller.current;
    if (marker === null || scroller === null) {
      lastEnd.current = null;
      return;
    }
    const inContent = (): number =>
      marker.getBoundingClientRect().bottom -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const now = inContent();
    const before = lastEnd.current;
    const edge = scroller.scrollTop + scroller.clientHeight;
    if (before !== null && now > before && before - edge <= NEAR_END_PX) {
      scroller.scrollTop += now - before;
    }
    lastEnd.current = inContent();
  }, [items.length, threads.scroller]);

  const live = (
    <VisuallyHidden>
      <span role="status" aria-live="polite">
        {said}
      </span>
    </VisuallyHidden>
  );

  // Nobody has replied and nobody is replying: nothing to show, and nothing to click.
  if (!expanded && replyCount === 0) return live;

  if (!expanded) {
    const whenLast =
      summary?.lastReplyAt == null ? '' : format.time(summary.lastReplyAt, new Date(nowMinute));
    return (
      <>
        <button
          type="button"
          aria-expanded="false"
          onClick={() => {
            threads.toggle(root.id);
          }}
          className="mt-1 flex h-control w-full items-center gap-2 rounded-sm text-label text-ink-muted hover:text-ink"
        >
          {resolved ? (
            <span className="inline-flex items-center gap-2">
              <span className="inline-flex text-success-text">
                <Icon name="resolved" size="sm" />
              </span>
              {t('thread.resolved', {
                name: summary.resolvedBy?.username ?? '',
                replies: counted,
              })}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 text-warning-text">
              <Icon name="open-question" size="sm" />
              {t('thread.open', { replies: counted, when: whenLast })}
            </span>
          )}
          <span className="ml-auto inline-flex items-center gap-2">
            {t('thread.show')}
            <Kbd>T</Kbd>
          </span>
        </button>
        {live}
      </>
    );
  }

  return (
    <section
      ref={section}
      data-thread-root={root.id}
      aria-label={t('thread.label', {
        name: root.sender.username,
        status: t(resolved ? 'thread.status.resolved' : 'thread.status.open'),
      })}
      className="mt-2"
    >
      <div ref={body} className="flex flex-col gap-2 border-l-marker border-border-strong pl-3">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded="true"
            onClick={() => {
              threads.toggle(root.id);
            }}
            className="inline-flex h-control items-center gap-2 text-label text-ink-muted hover:text-ink"
          >
            <Icon name="collapse" size="sm" />
            {replyCount === 0 ? t('thread.none') : counted}
          </button>
          <div className="flex gap-2">
            {replyCount > 0 && (
              <Button variant="secondary" glyph="resolved" busy={busy} onClick={toggleResolution}>
                {t(resolved ? 'thread.reopen' : 'thread.resolve')}
                <Kbd>⌘⇧R</Kbd>
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => {
                threads.collapse(root.id);
              }}
            >
              {t('thread.collapse')}
              <Kbd>Esc</Kbd>
            </Button>
          </div>
        </div>

        {replyCount > 0 && query.isPending && (
          <LoadingStatus label={t('thread.loading')} className="flex flex-col gap-2 py-1">
            <Skeleton className="w-feed" />
            <Skeleton className="w-sidebar" />
          </LoadingStatus>
        )}
        {query.isError && query.data === undefined && (
          <div role="alert" className="flex items-center gap-2 text-label text-danger-text">
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
            meId={meId}
            nowMinute={nowMinute}
            members={members}
            tabIndex={-1}
            onRetry={engine.retry}
            onDiscard={engine.discard}
          />
        ))}

        {query.hasNextPage && (
          <div>
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
        <div ref={end} />
      </div>
      <Composer
        channelId={root.channelId}
        channelName={t('thread.composerName', { channel: channelName })}
        parentId={root.id}
      />
      {live}
    </section>
  );
};

export const Thread = memo(ThreadView);
