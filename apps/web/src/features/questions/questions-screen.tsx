import type { QuestionFilters } from '@purlay/types';
import { Select } from '../../ui/select';
import { useSession } from '../session/session';
import { useMembers } from '../../data/queries';
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
import { useId, useMemo } from 'react';
import type { Channel, Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannels, useUnresolved, readingOrder } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { channelInSearch, threadHref } from '../../router/routes';
import { Link, useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Avatar } from '../../ui/avatar';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState, GlyphEmptyState } from '../../ui/states';
import { useFeedPorts } from '../channel/feed-ports';
import {
  activeSegmentClasses,
  HeaderTile,
  segmentClasses,
  segmentTrackClasses,
  useChannelTitle,
} from '../channel/channel-header';
import { NavToggle } from '../shell/nav';
import { ListCard, ListColumn, listButtonClasses, listRowClasses } from '../../ui/list-column';
import { useWorkspace } from '../shell/workspace';
import { lastChannel } from './last-channel';
import { useOpenCount } from './use-open-count';
import { authorOf } from '../messages/author';
import { useMessageText } from '../content/github-event';

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

const Header = ({ narrowed }: { readonly narrowed: string | null }): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const open = useOpenCount(workspace.id, narrowed);
  const joined = (channels.data ?? []).filter((c) => c.state !== null);
  const remembered = narrowed ?? lastChannel(workspace.id);
  // Narrowed to a channel, Feed goes back to it, whether or not the person is in it.
  const back =
    (channels.data ?? []).find((c) => c.id === narrowed) ??
    joined.find((c) => c.id === remembered) ??
    joined[0];

  return (
    <header className="flex h-header shrink-0 items-center gap-3 border-b-hairline border-border-subtle pr-4 pl-6 max-narrow:pl-4">
      <div data-header-title="" className="flex min-w-0 flex-1 items-center gap-2">
        <NavToggle />
        <HeaderTile>
          <Icon name="open-question" size="lg" />
        </HeaderTile>
        <div className="flex min-w-0 flex-col">
          <h1 className="whitespace-nowrap text-heading text-ink">{t('questions.title')}</h1>
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
            <span className="font-mono text-caption text-warning-text">
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
    <h2 id={id} className="text-label text-ink-muted">
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
    <h2 id={id} className="flex items-center gap-1 text-label text-ink-muted">
      <Icon name={channel.type === 'direct_message' ? 'person' : 'channel'} size="sm" />
      <span>{title}</span>
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
  const textOf = useMessageText();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const members = useMembers(workspace.id);
  const owner = members.data?.find(
    (member) => member.user.id === question.thread?.knowledge?.assigneeId,
  );
  const age = Math.max(
    0,
    Math.floor((now.getTime() - new Date(question.createdAt).getTime()) / 86_400_000),
  );
  const replies = t('thread.replies', { count: question.thread?.replyCount ?? 0 });
  const last = question.thread?.lastReplyAt ?? question.createdAt;
  return (
    <li className={listRowClasses}>
      <button
        type="button"
        onClick={() => {
          navigate(threadHref(workspace.slug, question.channelId, question.id));
        }}
        className={listButtonClasses()}
      >
        <Avatar
          name={authorOf(question, t('user.erased')).displayName}
          username={authorOf(question, t('user.erased')).username}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="text-body font-semibold text-ink">
              {authorOf(question, t('user.erased')).displayName}
            </span>
            <time dateTime={question.createdAt} className="font-mono text-caption text-ink-subtle">
              {format.time(question.createdAt, now)}
            </time>
            {/* On the author's line, where a wide window drew it anyway: as a column of its own it
            left a phone's excerpt two words a line (#688). */}
            <span className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-pill bg-warning-subtle px-2 text-caption font-medium text-warning-text">
              <Icon name="reply" size="sm" />
              {t('questions.replies', { replies, when: format.time(last, now) })}
            </span>
          </span>
          <span className="block truncate text-body text-ink max-narrow:line-clamp-2 max-narrow:whitespace-normal">
            {textOf(question)}
          </span>
          <span className="block text-caption text-ink-muted">
            {t('questions.waiting', { days: String(age) })}
            {' · '}
            {owner?.user.displayName ?? t('knowledge.unassigned')}
          </span>
        </span>
      </button>
    </li>
  );
};

/** Narrowed to one channel (from its header): which, and the way back to every channel. */
const Narrowed = ({ channel }: { readonly channel: Channel | undefined }): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  return (
    <p className="flex flex-wrap items-center gap-2 text-label text-ink-muted">
      {channel === undefined ? null : (
        <>
          <NarrowedName channel={channel} />
          <span aria-hidden="true">·</span>
        </>
      )}
      <Link
        to="questions"
        params={{ slug: workspace.slug }}
        className="rounded-sm text-accent-text hover:underline"
      >
        {t('questions.everyChannel')}
      </Link>
    </p>
  );
};

const NarrowedName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const title = useChannelTitle(channel);
  return (
    <span>
      {t('questions.only', { name: channel.type === 'direct_message' ? title : `#${title}` })}
    </span>
  );
};

export const QuestionsScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { search, navigate } = useRoute();
  const { user } = useSession();
  const filterId = useId();
  const params = new URLSearchParams(search);
  const only = params.get('show') ?? 'all';
  const oldest = params.get('order') === 'oldest';
  const filters: QuestionFilters = {
    ...(only === 'unanswered' ? { unanswered: 'yes' as const } : {}),
    ...(only === 'mine' ? { assigneeId: user.id } : {}),
    ...(oldest ? { order: 'oldest' as const } : {}),
  };
  const changeFilter = (key: string, value: string): void => {
    const next = new URLSearchParams(search);
    if (value === '') next.delete(key);
    else next.set(key, value);
    navigate(`/w/${encodeURIComponent(workspace.slug)}/questions?${next.toString()}`);
  };
  const narrowed = channelInSearch(search);
  const ports = useFeedPorts();
  // Narrowed, the server is asked for that channel's questions: filtered from the workspace's pages,
  // a quiet channel's sat behind other channels' and needed Load more to appear.
  const query = useUnresolved(workspace.id, narrowed, filters);
  const channels = useChannels(workspace.id);
  const questions = useMemo(() => readingOrder(query.data), [query.data]);
  const groups = useMemo(() => {
    const grouped = groupByChannel(questions);
    if (!oldest) return grouped;
    return grouped
      .map((group) => ({ ...group, questions: [...group.questions].reverse() }))
      .sort((left, right) =>
        (left.questions[0]?.id ?? '').localeCompare(right.questions[0]?.id ?? ''),
      );
  }, [questions, oldest]);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const now = ports.clock.now();

  let body: React.JSX.Element;
  if (query.isPending) {
    body = (
      <LoadingStatus label={t('state.questions.loading')} className="flex flex-col gap-4 py-2">
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
  } else if (groups.length === 0 && !query.hasNextPage) {
    body = (
      <>
        <GlyphEmptyState
          glyph="resolved"
          tone="success"
          title={t(only === 'all' ? 'state.questions.empty.title' : 'questions.filteredEmpty')}
          body={t(only === 'all' ? 'state.questions.empty.body' : 'questions.filteredHint')}
        />
        {narrowed !== null && (
          <div className="flex justify-center pb-6">
            <Narrowed channel={undefined} />
          </div>
        )}
      </>
    );
  } else {
    body = (
      <>
        {narrowed !== null && <Narrowed channel={byId.get(narrowed)} />}
        {groups.map((group) => {
          const id = `questions-${group.channelId}`;
          return (
            <ListCard
              key={group.channelId}
              headingId={id}
              heading={
                <GroupTitle
                  channel={byId.get(group.channelId)}
                  count={group.questions.length}
                  id={id}
                />
              }
            >
              {group.questions.map((question) => (
                <QuestionRow key={question.id} question={question} now={now} />
              ))}
            </ListCard>
          );
        })}
        {query.hasNextPage && (
          <div className="flex justify-center">
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
        <p className="text-center text-caption text-ink-muted">{t('questions.footer')}</p>
      </>
    );
  }

  return (
    <>
      <Header narrowed={narrowed} />
      <ListColumn>
        <div className="flex flex-wrap items-end gap-3">
          <label htmlFor={filterId} className="flex flex-col gap-1 text-label text-ink">
            {t('questions.filter')}
            <Select
              id={filterId}
              value={only}
              onChange={(event) => {
                changeFilter('show', event.target.value);
              }}
            >
              <option value="all">{t('questions.all')}</option>
              <option value="unanswered">{t('knowledge.unanswered')}</option>
              <option value="mine">{t('questions.mine')}</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-label text-ink">
            {t('questions.sort')}
            <Select
              value={oldest ? 'oldest' : 'newest'}
              onChange={(event) => {
                changeFilter('order', event.target.value);
              }}
            >
              <option value="newest">{t('questions.newest')}</option>
              <option value="oldest">{t('questions.oldest')}</option>
            </Select>
          </label>
        </div>
        {body}
      </ListColumn>
    </>
  );
};
