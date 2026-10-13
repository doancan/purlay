/**
 * The line under a root that says where its thread stands, and opens it in the panel (`UX.md`
 * §4.1, D-126): "Open · 4 replies · last 12m ago" or "Resolved by alice · 4 replies", and
 * **Show thread** with its key.
 *
 * **A root nobody has replied to has no line at all** — an empty control on every message is
 * clutter that teaches people to ignore that region — and a reply never has one: depth is two
 * levels (I-1), so the limit is not something a person can bump into.
 *
 * **Resolving lives here**, on the row, not in the panel: ⌘⇧R works on a focused root whether or
 * not its thread is open, so what resolves a thread is the one thing every root with replies has.
 * The panel's Resolve button asks this. Resolved from here while the thread is open, the panel
 * folds away with the product's one animation (`collapse.ts`) and closes; resolved somewhere
 * else, it stays where the reader is and only its status changes. Nothing is posted: the
 * resolution is metadata on the root.
 */
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/kbd';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { useThreads } from './thread-context';

/** The id of the panel, which the line it opens from controls. */
export const THREAD_PANEL_ID = 'thread-panel';

/** The thread's state as a pill: the same words in the feed and in the panel. */
export const ThreadStatus = ({
  root,
  nowMinute,
}: {
  readonly root: Message;
  readonly nowMinute: number;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const summary = root.thread;
  const counted = t('thread.replies', { count: summary?.replyCount ?? 0 });
  if (summary?.resolvedAt != null) {
    return (
      <span className="inline-flex h-6 items-center gap-1 rounded-pill bg-success-subtle px-2 text-caption font-medium text-success-text">
        <Icon name="resolved" size="sm" />
        {t('thread.resolved', { name: summary.resolvedBy?.username ?? '', replies: counted })}
      </span>
    );
  }
  const whenLast =
    summary?.lastReplyAt == null ? '' : format.time(summary.lastReplyAt, new Date(nowMinute));
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-pill bg-warning-subtle px-2 text-caption font-medium text-warning-text">
      <Icon name="open-question" size="sm" />
      {t('thread.open', { replies: counted, when: whenLast })}
    </span>
  );
};

export interface ThreadSummaryProps {
  readonly root: Message;
  readonly nowMinute: number;
  /** This root's thread is the one open in the panel. */
  readonly open: boolean;
}

const ThreadSummaryView = ({ root, nowMinute, open }: ThreadSummaryProps): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const threads = useThreads();
  const actions = useActions();
  const toast = useToast();
  const replyCount = root.thread?.replyCount ?? 0;
  const resolved = root.thread?.resolvedAt != null;
  const [said, setSaid] = useState('');
  // Held across renders so a keypress and a click that race are one resolution.
  const working = useRef(false);

  const toggleResolution = useCallback((): void => {
    if (working.current || replyCount === 0) return;
    working.current = true;
    void (async (): Promise<void> => {
      try {
        if (resolved) {
          await actions.reopen(root);
          setSaid(t('thread.announce.reopened'));
        } else {
          await actions.resolve(root);
          setSaid(t('thread.announce.resolved'));
          await threads.settle(root.id);
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
      }
    })();
  }, [replyCount, resolved, actions, root, t, threads, toast, describe]);

  // What the keyboard and the panel may do to this thread, read fresh each time they ask.
  const latest = useRef({ replyCount, toggle: toggleResolution });
  latest.current = { replyCount, toggle: toggleResolution };
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

  const live = (
    <VisuallyHidden>
      <span role="status" aria-live="polite">
        {said}
      </span>
    </VisuallyHidden>
  );

  // Nobody has replied: nothing to show, and nothing to click.
  if (replyCount === 0) return live;

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? THREAD_PANEL_ID : undefined}
        data-thread-summary=""
        onClick={() => {
          threads.open(root.id);
        }}
        className={cn(
          'mt-2 flex h-control w-full items-center gap-2 rounded-sm px-2 text-label font-medium text-accent-text transition-colors duration-hover ease-standard hover:bg-accent-subtle',
          // The one open in the panel is marked as such, so the eye finds where it came from.
          open && 'bg-accent-subtle',
        )}
      >
        <ThreadStatus root={root} nowMinute={nowMinute} />
        <span className="ml-auto inline-flex items-center gap-2">
          {t(open ? 'thread.shown' : 'thread.show')}
          <Kbd>T</Kbd>
        </span>
      </button>
      {live}
    </>
  );
};

export const ThreadSummary = memo(ThreadSummaryView);
