/**
 * A channel's repository feeds (#79, D-134), in its details, for an owner or an admin: which
 * repositories it hears from, what each last did, and why it last failed; connecting one, and
 * regenerating the secret of one and disconnecting one, each of which asks first, in place, as leaving does.
 *
 * Connecting answers with what GitHub needs — the payload address, the content type and the secret —
 * and the secret is shown here once: it is never sent again, so it is copied now or the feed is
 * regenerated from the feed, which keeps its address, the old secret dying at once (D-134 §3, amended;
 * #884). It stays on the screen until the person says Done.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GITHUB_FEED_EVENTS,
  type Channel,
  type CreatedGitHubFeed,
  type GitHubFeed,
  type GitHubFeedEventName,
} from '@purlay/types';
import { useEffect, useId, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { Checkbox } from '../../ui/checkbox';

/** `CreateGitHubFeedRequest`'s rule, so the common slip is answered before a round trip. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

const sectionTitle = 'text-label font-semibold text-ink';

/** The address GitHub posts to: this server's own origin and the path the feed was given. */
const addressOf = (created: CreatedGitHubFeed): string =>
  `${window.location.origin}${created.webhookPath}`;

const Setup = ({
  created,
  regenerated,
  onDone,
}: {
  readonly created: CreatedGitHubFeed;
  /** The feed was there already: only its secret is new, and GitHub's webhook is edited, not added. */
  readonly regenerated: boolean;
  readonly onDone: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { show } = useToast();
  const ports = useContentPorts();
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // The person's attention goes where the secret is, the one time it can be read.
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const copy = (text: string): void => {
    ports.copy(text).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };
  const rows: [string, string][] = [
    [t('feeds.setup.address'), addressOf(created)],
    [t('feeds.setup.contentType'), 'application/json'],
    [t('feeds.setup.secret'), created.secret],
  ];
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-lg border-hairline border-border-subtle bg-surface-050 p-3"
    >
      <h3 id={titleId} ref={heading} tabIndex={-1} className="text-label font-semibold text-ink">
        {t(regenerated ? 'feeds.setup.regeneratedTitle' : 'feeds.setup.title', {
          repository: created.feed.repository,
        })}
      </h3>
      <p className="text-label text-ink-muted">
        {t(regenerated ? 'feeds.setup.regeneratedSteps' : 'feeds.setup.steps')}
      </p>
      <dl className="flex flex-col gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-center gap-2">
            <dt className="w-1/4 shrink-0 text-label text-ink-muted">{label}</dt>
            <dd className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-label text-ink">{value}</span>
              <Button
                variant="ghost"
                aria-label={t('feeds.setup.copy', { what: label })}
                onClick={() => {
                  copy(value);
                }}
              >
                {t('common.copy')}
              </Button>
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-label text-warning-text">{t('feeds.setup.once')}</p>
      <div className="flex justify-end">
        <Button onClick={onDone}>{t('feeds.setup.done')}</Button>
      </div>
    </section>
  );
};

type Question = 'disconnect' | 'regenerate';

const Feed = ({
  feed,
  onDisconnect,
  onRegenerate,
}: {
  readonly feed: GitHubFeed;
  readonly onDisconnect: (feed: GitHubFeed) => Promise<boolean>;
  readonly onRegenerate: (feed: GitHubFeed) => Promise<boolean>;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const [asking, setAsking] = useState<Question | null>(null);
  const [busy, setBusy] = useState(false);
  const questionId = useId();
  const box = useRef<HTMLLIElement>(null);
  const asked = useRef<Question | null>(null);
  useEffect(() => {
    if (asking !== null) {
      asked.current = asking;
      box.current?.querySelector<HTMLElement>('[data-answer="cancel"]')?.focus();
    } else if (asked.current !== null) {
      box.current?.querySelector<HTMLElement>(`[data-ask="${asked.current}"]`)?.focus();
      asked.current = null;
    }
  }, [asking]);
  return (
    <li ref={box} className="flex flex-col gap-1 rounded-lg px-2 py-2 hover:bg-surface-200">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-body text-ink">
          {feed.repository}
        </span>
        {asking === null && (
          <>
            <Button
              variant="ghost"
              data-ask="regenerate"
              aria-label={t('feeds.regenerateOne', { repository: feed.repository })}
              onClick={() => {
                setAsking('regenerate');
              }}
            >
              {t('feeds.regenerate')}
            </Button>
            <Button
              variant="dangerQuiet"
              data-ask="disconnect"
              aria-label={t('feeds.disconnectOne', { repository: feed.repository })}
              onClick={() => {
                setAsking('disconnect');
              }}
            >
              {t('feeds.disconnect')}
            </Button>
          </>
        )}
      </div>
      <span className="text-caption text-ink-muted">
        {feed.events.map((name) => t(`feeds.event.${name}`)).join(', ')}
        {' · '}
        {feed.lastDeliveryAt === null
          ? t('feeds.neverDelivered')
          : t('feeds.lastDelivery', { when: format.absolute(feed.lastDeliveryAt) })}
      </span>
      {feed.lastFailure !== null && (
        <span className="text-caption text-danger-text">
          {t(`feeds.failure.${feed.lastFailure.reason}`, {
            when: format.absolute(feed.lastFailure.at),
          })}
        </span>
      )}
      {asking !== null && (
        <div role="group" aria-labelledby={questionId} className="flex flex-col gap-2">
          <p id={questionId} className="text-label text-ink">
            {t(asking === 'regenerate' ? 'feeds.regenerateAsk' : 'feeds.disconnectAsk', {
              repository: feed.repository,
            })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              data-answer="cancel"
              onClick={() => {
                setAsking(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => {
                setBusy(true);
                void (asking === 'regenerate' ? onRegenerate(feed) : onDisconnect(feed)).then(
                  (done) => {
                    setBusy(false);
                    // A regenerated feed stays in the list, its question answered; a disconnected one is gone.
                    if (!done || asking === 'regenerate') setAsking(null);
                  },
                );
              }}
            >
              {t(asking === 'regenerate' ? 'feeds.regenerate' : 'feeds.disconnect')}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
};

export const GitHubFeeds = ({ channel }: { readonly channel: Channel }): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const formId = useId();
  const titleId = useId();
  const [repository, setRepository] = useState('');
  const [events, setEvents] = useState<readonly GitHubFeedEventName[]>(['push']);
  const [problem, setProblem] = useState<{ field: 'repository' | 'form'; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    readonly feed: CreatedGitHubFeed;
    readonly regenerated: boolean;
  } | null>(null);

  const feeds = useQuery({
    queryKey: keys.githubFeeds(channel.id),
    queryFn: async ({ signal }) => await api.githubFeeds(channel.id, signal),
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.githubFeeds(channel.id) });
    // The channel's code references link into its one feed's repository (D-223): it may have changed.
    await client.invalidateQueries({ queryKey: keys.channels(channel.workspaceId) });
  };

  const connect = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const wanted = repository.trim();
    if (!REPOSITORY.test(wanted)) {
      setProblem({ field: 'repository', message: t('feeds.invalidRepository') });
      return;
    }
    if (events.length === 0) {
      setProblem({ field: 'form', message: t('feeds.noEvents') });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      setCreated({
        feed: await api.connectGitHubFeed(channel.id, { repository: wanted, events: [...events] }),
        regenerated: false,
      });
      setRepository('');
      await reread();
    } catch (failure) {
      setProblem({ field: 'form', message: `${t('feeds.connectFailed')} ${describe(failure)}` });
    } finally {
      setBusy(false);
    }
  };

  const regenerate = async (feed: GitHubFeed): Promise<boolean> => {
    setProblem(null);
    try {
      setCreated({
        feed: await api.regenerateGitHubFeedSecret(channel.id, feed.id),
        regenerated: true,
      });
      return true;
    } catch (failure) {
      setProblem({ field: 'form', message: `${t('feeds.regenerateFailed')} ${describe(failure)}` });
      return false;
    }
  };

  const disconnect = async (feed: GitHubFeed): Promise<boolean> => {
    setProblem(null);
    try {
      await api.disconnectGitHubFeed(channel.id, feed.id);
      await reread();
      return true;
    } catch (failure) {
      setProblem({ field: 'form', message: `${t('feeds.disconnectFailed')} ${describe(failure)}` });
      return false;
    }
  };

  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className={sectionTitle}>
        {t('feeds.title')}
      </h3>
      {feeds.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">{describe(feeds.error)}</p>
          <Button
            onClick={() => {
              void feeds.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : feeds.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
        </LoadingStatus>
      ) : feeds.data.length === 0 ? (
        <p className="text-body text-ink-muted">{t('feeds.empty')}</p>
      ) : (
        <ul className="flex flex-col">
          {feeds.data.map((feed) => (
            <Feed key={feed.id} feed={feed} onDisconnect={disconnect} onRegenerate={regenerate} />
          ))}
        </ul>
      )}
      {problem?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {problem.message}
        </p>
      )}
      {created === null ? (
        <form
          id={formId}
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            void connect(event);
          }}
        >
          <TextField
            label={t('feeds.repository')}
            hint={t('feeds.repositoryHint')}
            value={repository}
            autoComplete="off"
            spellCheck={false}
            {...(problem?.field === 'repository' ? { error: problem.message } : {})}
            onChange={(event) => {
              setRepository(event.target.value);
            }}
          />
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
            <legend className="mb-1 text-label text-ink">{t('feeds.events')}</legend>
            {GITHUB_FEED_EVENTS.map((name) => (
              <label key={name} className="flex items-start gap-2 text-body text-ink">
                <Checkbox
                  checked={events.includes(name)}
                  onChange={(event) => {
                    setEvents(
                      event.target.checked
                        ? GITHUB_FEED_EVENTS.filter(
                            (each) => each === name || events.includes(each),
                          )
                        : events.filter((each) => each !== name),
                    );
                  }}
                />
                {t(`feeds.event.${name}`)}
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" busy={busy}>
              {t('feeds.connect')}
            </Button>
          </div>
        </form>
      ) : (
        <Setup
          created={created.feed}
          regenerated={created.regenerated}
          onDone={() => {
            setCreated(null);
          }}
        />
      )}
    </section>
  );
};
