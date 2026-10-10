/**
 * The open-questions view (`UX.md` §4.4): the questions your team has not finished
 * answering — every unresolved root that has at least one reply, in the channels you can
 * see, newest first and grouped by channel.
 *
 * It is the product's argument in one screen, and it is not a second kind of list: it is the
 * workspace's `unresolved` read, the same cache entry the count on the tab and in the sidebar
 * counts, kept current by the same `THREAD_UPDATED` frames — a thread resolved anywhere (here
 * included) leaves this list without anyone asking it to.
 *
 * A question is a button, not a drawer: it takes the person to its channel with its thread
 * already open and in view (`?thread=`, `router/routes.ts`), because the answer to *why is
 * this still open* is in the conversation and not in a summary of it.
 *
 * Loading, empty and failed are all designed (§8): a skeleton in the list's own rows, "Every
 * thread is resolved" with the resolved glyph, and a Retry with the reason.
 */
import { useMemo } from 'react';
import type { Channel, Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannels, useUnresolved, readingOrder } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { threadHref } from '../../router/routes';
import { Link, useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useFeedPorts } from '../channel/feed-ports';
import {
  activeSegmentClasses,
  HeaderTile,
  segmentClasses,
  segmentTrackClasses,
  useChannelTitle,
} from '../channel/channel-header';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';
import { lastChannel } from './last-channel';
import { useOpenCount } from './use-open-count';

interface Group {
  readonly channelId: string;
  readonly questions: readonly Message[];
}

/** Questions grouped by channel; groups ordered by their newest question, questions newest first. */
export const groupByChannel = (questions: readonly Message[]): Group[] => {
  const groups = new Map<string, Message[]>();
  for (const question of questions) {
    const list = groups.get(question.channelId) ?? [];
    list.push(question);
    groups.set(question.channelId, list);
  }
  return [...groups.entries()]
    .map(([channelId, list]) => ({
      channelId,
      questions: [...list].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)),
    }))
    .sort((a, b) => {
      const left = a.questions[0]?.id ?? '';
      const right = b.questions[0]?.id ?? '';
      return left < right ? 1 : left > right ? -1 : 0;
    });
};

const Header = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const open = useOpenCount(workspace.id);
  const joined = (channels.data ?? []).filter((c) => c.state !== null);
  const remembered = lastChannel(workspace.id);
  const back = joined.find((c) => c.id === remembered) ?? joined[0];

  return (
    <header className="flex h-header shrink-0 items-center justify-between gap-4 border-b-hairline border-border-subtle px-4">
      <div className="flex min-w-0 items-center gap-2">
        <NavToggle />
        <HeaderTile>
          <Icon name="open-question" size="lg" />
        </HeaderTile>
        <div className="flex min-w-0 flex-col">
          <h1 className="whitespace-nowrap text-title text-ink">{t('questions.title')}</h1>
          <span className="truncate text-caption text-ink-muted max-narrow:hidden">
            {t('questions.lede')}
          </span>
        </div>
      </div>
      <nav aria-label={t('header.views')} className={segmentTrackClasses}>
        {back === undefined ? (
          <Link
            to="workspace"
            params={{ slug: workspace.slug }}
            className={cn(segmentClasses, 'text-ink-muted')}
          >
            {t('header.feed')}
          </Link>
        ) : (
          <Link
            to="channel"
            params={{ slug: workspace.slug, channelId: back.id }}
            className={cn(segmentClasses, 'text-ink-muted')}
          >
            {t('header.feed')}
          </Link>
        )}
        <Link
          to="questions"
          params={{ slug: workspace.slug }}
          aria-current="page"
          className={cn(segmentClasses, activeSegmentClasses)}
        >
          {t('header.questions')}
          {open !== null && open.count > 0 && (
            <span className="font-mono text-warning-text">
              {format.number(open.count)}
              {open.more && '+'}
            </span>
          )}
        </Link>
      </nav>
    </header>
  );
};

const GroupTitle = ({
  channel,
  count,
  id,
}: {
  readonly channel: Channel | undefined;
  readonly count: number;
  readonly id: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  // A hook cannot be called conditionally, so a channel the person can no longer see gets a
  // stand-in that never reaches `useChannelTitle`.
  return channel === undefined ? (
    <h2 id={id} className="px-3 pb-2 text-label text-ink-muted">
      {t('questions.unnamed')}
    </h2>
  ) : (
    <KnownGroupTitle channel={channel} count={count} id={id} />
  );
};

const KnownGroupTitle = ({
  channel,
  count,
  id,
}: {
  readonly channel: Channel;
  readonly count: number;
  readonly id: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const title = useChannelTitle(channel);
  return (
    <h2 id={id} className="flex items-center gap-1 px-3 pb-2 text-label text-ink-muted">
      <Icon name={channel.type === 'direct_message' ? 'person' : 'channel'} size="sm" />
      <span className="font-mono">{title}</span>
      <span aria-hidden="true">·</span>
      <span>{t('questions.count', { count })}</span>
    </h2>
  );
};

const QuestionRow = ({
  question,
  now,
}: {
  readonly question: Message;
  readonly now: Date;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const replies = t('thread.replies', { count: question.thread?.replyCount ?? 0 });
  const last = question.thread?.lastReplyAt ?? question.createdAt;
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          navigate(threadHref(workspace.slug, question.channelId, question.id));
        }}
        className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-surface-200"
      >
        <Avatar name={question.sender.displayName} username={question.sender.username} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-heading text-ink">{question.sender.username}</span>
            <time dateTime={question.createdAt} className="font-mono text-caption text-ink-muted">
              {format.time(question.createdAt, now)}
            </time>
          </span>
          <span className="block truncate text-body text-ink">{question.content}</span>
        </span>
        <span className="inline-flex h-badge shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border-hairline border-border-subtle px-2 text-label text-warning-text">
          <Icon name="reply" size="sm" />
          {t('questions.replies', { replies, when: format.time(last, now) })}
        </span>
      </button>
    </li>
  );
};

export const QuestionsScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const ports = useFeedPorts();
  const query = useUnresolved(workspace.id);
  const channels = useChannels(workspace.id);
  const questions = useMemo(() => readingOrder(query.data), [query.data]);
  const groups = useMemo(() => groupByChannel(questions), [questions]);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const now = ports.clock.now();

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus
        label={t('state.questions.loading')}
        className="mx-auto flex w-full max-w-feed flex-col gap-4 px-4 py-4"
      >
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
        title={t('state.questions.error.title')}
        body={t('state.questions.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (groups.length === 0) {
    body = (
      <section className="mx-auto flex max-w-feed flex-col items-center gap-3 px-4 py-16 text-center">
        <span
          aria-hidden="true"
          className="inline-flex size-avatar-lg items-center justify-center rounded-md bg-surface-200 text-success-text"
        >
          <Icon name="resolved" size="lg" />
        </span>
        <h2 className="text-title text-ink">{t('state.questions.empty.title')}</h2>
        <p className="text-body text-ink-muted">{t('state.questions.empty.body')}</p>
      </section>
    );
  } else {
    body = (
      <div className="mx-auto flex w-full max-w-feed flex-col gap-6 px-1 py-4">
        {groups.map((group) => {
          const id = `questions-${group.channelId}`;
          return (
            <section key={group.channelId} aria-labelledby={id}>
              <GroupTitle
                channel={byId.get(group.channelId)}
                count={group.questions.length}
                id={id}
              />
              <ul className="flex flex-col">
                {group.questions.map((question) => (
                  <QuestionRow key={question.id} question={question} now={now} />
                ))}
              </ul>
            </section>
          );
        })}
        {query.hasNextPage && (
          <div className="px-3">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('questions.more')}
            </Button>
          </div>
        )}
        <p className="px-3 text-caption text-ink-muted">{t('questions.footer')}</p>
      </div>
    );
  }

  return (
    <>
      <Header />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </>
  );
};
