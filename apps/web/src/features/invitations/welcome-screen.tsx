/**
 * `/w/:slug/welcome` — the step after accepting an invitation (#489, D-132): the workspace's public
 * channels to join now, the busiest marked and picked already, joined together in one press, or
 * skipped. A person who joins nothing still lands in the workspace, where Browse finds the rest.
 *
 * **Its states** (`UX.md` §8): the channels loading; failing, with Retry; none to join, with the way
 * on; and a join that fails part way, which says which channels it could not join and why — one
 * sentence for each why — keeps them picked unless they are gone, and offers to try those again;
 * those that were joined stay joined. Joins go a few at a time (the write budget is the one a first
 * message spends), and a person who leaves while they are on their way is told where they are.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Channel } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { codeOf, useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { useToast } from '../../ui/toast';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { ScreenBar } from '../shell/screen-bar';
import { useWorkspace } from '../shell/workspace';
import { joinableChannels } from '../sidebar/ordering';

/** How many of the busiest channels are marked and picked to begin with. */
const RECOMMENDED = 3;

/**
 * How many joins are on their way at once: each is a write on the person's budget, the same one
 * their first message spends, so a long pick is joined a few at a time rather than in one burst.
 */
const AT_ONCE = 4;

/** The busiest by their last message: where the conversation is. Silent channels are not offered. */
const recommendedOf = (channels: readonly Channel[]): ReadonlySet<string> =>
  new Set(
    channels
      .filter((c) => c.lastMessageAt !== null)
      .sort((a, b) => ((a.lastMessageAt ?? '') < (b.lastMessageAt ?? '') ? 1 : -1))
      .slice(0, RECOMMENDED)
      .map((c) => c.id),
  );

/** Runs each job, at most `limit` at a time, and answers each one's outcome in order. */
const settleInTurn = async <T,>(
  jobs: readonly (() => Promise<T>)[],
  limit: number,
): Promise<PromiseSettledResult<T>[]> => {
  const outcomes: PromiseSettledResult<T>[] = new Array<PromiseSettledResult<T>>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let at = next++; at < jobs.length; at = next++) {
      const job = jobs[at];
      if (job === undefined) continue;
      try {
        outcomes[at] = { status: 'fulfilled', value: await job() };
      } catch (reason) {
        outcomes[at] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  return outcomes;
};

/** What a failure to join says: the channels, named, with why — one sentence for each why. */
interface Refusal {
  readonly names: string;
  readonly why: string;
}

export const WelcomeScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const { joinChannel } = useActions();
  const { navigate, match } = useRoute();
  const channels = useChannels(workspace.id);
  const joinable = useMemo(() => joinableChannels(channels.data ?? []), [channels.data]);
  // Marked once, when the list first arrives: a list read again does not move the ticks or the
  // badges under the person (D-132 §4's reason, for this list).
  const [recommended, setRecommended] = useState<ReadonlySet<string> | null>(null);
  if (recommended === null && channels.data !== undefined) setRecommended(recommendedOf(joinable));
  const marked = recommended ?? new Set<string>();
  // Null until the person changes it: the recommended ones.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  // Only what is still there to join: a channel joined elsewhere, or gone, is not counted.
  const picked = new Set([...(chosen ?? marked)].filter((id) => joinable.some((c) => c.id === id)));
  const [joining, setJoining] = useState(false);
  const [refusals, setRefusals] = useState<readonly Refusal[]>([]);
  const submit = useRef<HTMLButtonElement>(null);
  // A join outlives the screen if the person leaves while it is on its way: its answer is then
  // said where they are, and nothing moves them.
  const here = useRef(true);
  const address = useRef(match);
  address.current = match;
  useEffect(() => {
    // Set on every mount, not only declared so: a remount (React's strict check does one) would
    // otherwise leave it false from the cleanup before.
    here.current = true;
    return (): void => {
      here.current = false;
    };
  }, []);

  const enter = (): void => {
    navigate(href('workspace', { slug: workspace.slug }), { replace: true });
  };

  const toggle = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChosen(next);
  };

  const join = async (): Promise<void> => {
    setJoining(true);
    setRefusals([]);
    const wanted = joinable.filter((c) => picked.has(c.id));
    const outcomes = await settleInTurn(
      wanted.map((c) => (): Promise<Channel> => joinChannel(c.id)),
      AT_ONCE,
    );
    const failed = wanted
      .map((channel, at) => ({ channel, outcome: outcomes[at] }))
      .filter(
        (each): each is { channel: Channel; outcome: PromiseRejectedResult } =>
          each.outcome?.status === 'rejected',
      );
    const stillHere = here.current && address.current.name === 'welcome';
    if (failed.length === 0) {
      if (stillHere) enter();
      return;
    }
    // What is gone is not offered again; the list is read again so the screen says so too.
    void client.invalidateQueries({ queryKey: keys.channels(workspace.id) });
    const byWhy = new Map<string, string[]>();
    for (const { channel, outcome } of failed) {
      const why = describe(outcome.reason);
      byWhy.set(why, [...(byWhy.get(why) ?? []), `#${channel.name ?? ''}`]);
    }
    const said = [...byWhy].map(([why, names]) => ({ names: names.join(', '), why }));
    if (!stillHere) {
      for (const refusal of said) {
        show({ message: `${t('welcome.failed', { names: refusal.names })} ${refusal.why}` });
      }
      return;
    }
    setJoining(false);
    setChosen(
      new Set(
        failed
          .filter(({ outcome }) => codeOf(outcome.reason) !== 'CHANNEL_NOT_FOUND')
          .map(({ channel }) => channel.id),
      ),
    );
    setRefusals(said);
  };

  // Once a refusal is drawn — the button no longer busy — focus is on what tries again.
  useEffect(() => {
    if (refusals.length > 0 && !joining) submit.current?.focus();
  }, [refusals, joining]);

  let body: React.JSX.Element;
  if (channels.isPending) {
    body = (
      <LoadingStatus label={t('welcome.loading')} className="flex flex-col gap-2">
        <Skeleton className="w-members" />
        <Skeleton className="w-sidebar" />
      </LoadingStatus>
    );
  } else if (channels.isError && channels.data === undefined) {
    body = (
      <ErrorState
        title={t('welcome.error.title')}
        body={t('welcome.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void channels.refetch();
        }}
      />
    );
  } else if (joinable.length === 0) {
    body = (
      <section className="flex flex-col items-start gap-3">
        <p className="text-body text-ink-muted">{t('welcome.none')}</p>
        <Button variant="primary" onClick={enter}>
          {t('welcome.continue')}
        </Button>
      </section>
    );
  } else {
    body = (
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        <fieldset className="flex flex-col gap-1">
          <legend>
            <VisuallyHidden>{t('welcome.title')}</VisuallyHidden>
          </legend>
          {joinable.map((channel) => (
            <label
              key={channel.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-surface-200"
            >
              <input
                type="checkbox"
                className="mt-1"
                // The channel's name is the box's; its topic and whether it is busy describe it.
                aria-label={`#${channel.name ?? ''}`}
                aria-describedby={`${channel.id}-about`}
                checked={picked.has(channel.id)}
                disabled={joining}
                onChange={() => {
                  toggle(channel.id);
                }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-body text-ink">
                  <span className="min-w-0 break-all">{`#${channel.name ?? ''}`}</span>
                  {/* What describes the box: whether it is busy, and what it is for — not its name again. */}
                  <span id={`${channel.id}-about`} className="flex flex-col gap-1">
                    {marked.has(channel.id) && (
                      <span className="self-start rounded-sm bg-accent-subtle px-1 font-sans text-caption text-accent-text">
                        {t('welcome.active')}
                      </span>
                    )}
                    {channel.topic !== null && (
                      <span className="break-words font-sans text-label text-ink-muted">
                        {channel.topic}
                      </span>
                    )}
                  </span>
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {refusals.length > 0 && (
          <div role="alert" className="flex flex-col gap-1 text-label text-danger-text">
            {refusals.map((refusal) => (
              <p key={refusal.names}>
                {`${t('welcome.failed', { names: refusal.names })} ${refusal.why}`}
              </p>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            ref={submit}
            type="submit"
            variant="primary"
            busy={joining}
            disabled={picked.size === 0}
          >
            {t('welcome.join', { count: picked.size })}
          </Button>
          <Button variant="ghost" disabled={joining} onClick={enter}>
            {t('welcome.skip')}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <>
      <ScreenBar />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <section className="flex w-full max-w-feed flex-col gap-4 px-6 py-8">
          <h1 className="text-display text-ink">
            {t('welcome.heading', { workspace: workspace.name })}
          </h1>
          <p className="text-body text-ink-muted">
            {t(marked.size > 0 ? 'welcome.lede' : 'welcome.ledeQuiet')}
          </p>
          {body}
        </section>
      </div>
    </>
  );
};
