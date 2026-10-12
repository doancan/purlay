/**
 * Search (D-105, `UX.md` §8): the words as typed, ignoring case, in every channel the person can see —
 * roots and replies, resolved threads too — newest first.
 *
 * The words live in the address (`?q=`), so Back, a reload and a link come back to the same results,
 * and pressing Enter is what searches: a search is a question asked once, not a list redrawn under
 * every keystroke. Fewer characters than the server takes are said in the field and never sent.
 * Arriving here focuses the page, as every navigation does (`ui/main.tsx`); the field is its first
 * stop, one Tab away.
 *
 * The states are the ones §8 names: progress inside the field, "No matches for …" with where it
 * looked, and a Retry that keeps the words.
 */
import { useId, useMemo, useState } from 'react';
import { SEARCH_QUERY_MIN, type Channel, type Message } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useChannels, useSearch } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { channelInSearch, href, searchHref, threadHref, wordsInSearch } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { ErrorState } from '../../ui/states';
import { TextField } from '../../ui/text-field';
import { HeaderTile, useChannelTitle } from '../channel/channel-header';
import { useFeedPorts } from '../channel/feed-ports';
import { NavToggle } from '../shell/nav';
import { useWorkspace } from '../shell/workspace';

/** Where a found message is read: in its thread when it is in one, in its channel otherwise. */
export const placeOf = (slug: string, message: Message): string => {
  if (message.parentId !== null) return threadHref(slug, message.channelId, message.parentId);
  if ((message.thread?.replyCount ?? 0) > 0) return threadHref(slug, message.channelId, message.id);
  return href('channel', { slug, channelId: message.channelId });
};

const ChannelName = ({ channel }: { readonly channel: Channel }): React.JSX.Element => (
  <span>{useChannelTitle(channel)}</span>
);

const Found = ({
  message,
  channel,
  now,
}: {
  readonly message: Message;
  readonly channel: Channel | undefined;
  readonly now: Date;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          navigate(placeOf(workspace.slug, message));
        }}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-hover ease-standard hover:bg-surface-050"
      >
        <Avatar name={message.sender.displayName} username={message.sender.username} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 text-label text-ink-muted">
            <span className="text-body font-semibold text-ink">{message.sender.username}</span>
            <span aria-hidden="true">·</span>
            {channel === undefined ? t('questions.unnamed') : <ChannelName channel={channel} />}
            {message.parentId !== null && <Icon name="reply" size="sm" />}
            <time dateTime={message.createdAt} className="ml-auto font-mono text-caption">
              {format.time(message.createdAt, now)}
            </time>
          </span>
          <span className="line-clamp-2 block text-body text-ink">{message.content}</span>
        </span>
      </button>
    </li>
  );
};

/** The screen for one address: Back to other words is a fresh field with those words in it. */
export const SearchScreen = (): React.JSX.Element => {
  const { search } = useRoute();
  const asked = wordsInSearch(search);
  return <SearchView key={asked} asked={asked} channelId={channelInSearch(search)} />;
};

/** How a channel is named in the choice of where to look: `#name`, or `@person` for a direct message. */
const placeName = (channel: Channel): string =>
  channel.type === 'direct_message'
    ? `@${channel.peer?.username ?? channel.name ?? ''}`
    : `#${channel.name ?? ''}`;

const SearchView = ({
  asked,
  channelId,
}: {
  readonly asked: string;
  readonly channelId: string | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const ports = useFeedPorts();
  const [draft, setDraft] = useState(asked);
  const [tooShort, setTooShort] = useState(false);
  const query = useSearch(workspace.id, asked, channelId);
  const whereId = useId();
  const channels = useChannels(workspace.id);
  const byId = useMemo(() => new Map((channels.data ?? []).map((c) => [c.id, c])), [channels.data]);
  const places = useMemo(
    () =>
      (channels.data ?? [])
        .map((channel) => ({ id: channel.id, name: placeName(channel) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [channels.data],
  );
  const narrowed = channelId === null ? undefined : byId.get(channelId);
  const found = useMemo(() => (query.data?.pages ?? []).flatMap((page) => page.data), [query.data]);
  const now = ports.clock.now();
  const searching =
    asked.length >= SEARCH_QUERY_MIN && query.isFetching && !query.isFetchingNextPage;

  let body: React.JSX.Element | null = null;
  if (asked.length < SEARCH_QUERY_MIN) {
    body = <p className="px-3 text-body text-ink-muted">{t('search.prompt')}</p>;
  } else if (query.isError && query.data === undefined) {
    body = (
      <ErrorState
        title={t('state.search.error.title')}
        body={t('state.search.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  } else if (query.isSuccess && found.length === 0) {
    body = (
      <section className="flex flex-col items-center gap-3 px-4 text-center">
        <h2 className="text-title text-ink">{t('state.search.empty.title', { words: asked })}</h2>
        <p className="text-body text-ink-muted">
          {narrowed === undefined
            ? t('state.search.empty.body')
            : t('state.search.empty.bodyIn', { channel: placeName(narrowed) })}
        </p>
      </section>
    );
  } else if (found.length > 0) {
    body = (
      <>
        <ul className="flex flex-col">
          {found.map((message) => (
            <Found
              key={message.id}
              message={message}
              channel={byId.get(message.channelId)}
              now={now}
            />
          ))}
        </ul>
        {query.hasNextPage && (
          <div className="px-3">
            <Button
              variant="secondary"
              busy={query.isFetchingNextPage}
              onClick={() => {
                void query.fetchNextPage();
              }}
            >
              {t('search.more')}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <header className="flex h-header shrink-0 items-center gap-2 border-b-hairline border-border-subtle pr-4 pl-5">
        <NavToggle />
        <HeaderTile>
          <Icon name="search" size="lg" />
        </HeaderTile>
        <h1 className="whitespace-nowrap text-heading text-ink">{t('search.title')}</h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex w-full max-w-feed flex-col gap-4 px-3 py-4">
          <form
            role="search"
            className="px-3"
            onSubmit={(event) => {
              event.preventDefault();
              const words = draft.trim();
              setTooShort(words.length < SEARCH_QUERY_MIN);
              if (words.length >= SEARCH_QUERY_MIN) {
                navigate(searchHref(workspace.slug, words, channelId));
              }
            }}
          >
            <TextField
              label={t('search.label')}
              type="search"
              value={draft}
              autoComplete="off"
              aria-busy={searching}
              {...(tooShort
                ? { error: t('search.tooShort', { min: String(SEARCH_QUERY_MIN) }) }
                : {
                    hint: searching
                      ? t('search.searching')
                      : narrowed === undefined
                        ? t('search.hint')
                        : t('search.hintIn', { channel: placeName(narrowed) }),
                  })}
              onChange={(event) => {
                setDraft(event.target.value);
              }}
            />
            <div className="mt-3 flex items-center gap-2">
              <label htmlFor={whereId} className="text-label text-ink-muted">
                {t('search.where')}
              </label>
              <select
                id={whereId}
                value={channelId ?? ''}
                onChange={(event) => {
                  const chosen = event.target.value;
                  navigate(searchHref(workspace.slug, asked, chosen === '' ? null : chosen));
                }}
                className="min-w-0 rounded-md border-hairline border-border-subtle bg-surface-000 px-2 py-1 text-label text-ink"
              >
                <option value="">{t('search.everywhere')}</option>
                {places.map((place) => (
                  <option key={place.id} value={place.id}>
                    {place.name}
                  </option>
                ))}
              </select>
            </div>
          </form>
          {body}
        </div>
      </div>
    </>
  );
};
