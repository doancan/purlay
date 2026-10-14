/**
 * `/w/:slug/welcome` — the step after accepting an invitation (#489, D-132): the workspace's public
 * channels to join now, the busiest marked and picked already, joined together in one press, or
 * skipped. A person who joins nothing still lands in the workspace, where Browse finds the rest.
 *
 * **Its states** (`UX.md` §8): the channels loading; failing, with Retry; none to join, with the way
 * on; and a join that fails part way, which says which channels it could not join, keeps them
 * picked, and offers to try those again — those that were joined stay joined.
 */
import { useMemo, useState } from 'react';
import type { Channel } from '@purlay/types';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { ErrorState } from '../../ui/states';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { ScreenBar } from '../shell/screen-bar';
import { useWorkspace } from '../shell/workspace';
import { joinableChannels } from '../sidebar/ordering';

/** How many of the busiest channels are marked and picked to begin with. */
const RECOMMENDED = 3;

/** The busiest by their last message: where the conversation is. Silent channels are not offered. */
const recommendedOf = (channels: readonly Channel[]): ReadonlySet<string> =>
  new Set(
    channels
      .filter((c) => c.lastMessageAt !== null)
      .sort((a, b) => ((a.lastMessageAt ?? '') < (b.lastMessageAt ?? '') ? 1 : -1))
      .slice(0, RECOMMENDED)
      .map((c) => c.id),
  );

export const WelcomeScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { joinChannel } = useActions();
  const { navigate } = useRoute();
  const channels = useChannels(workspace.id);
  const joinable = useMemo(() => joinableChannels(channels.data ?? []), [channels.data]);
  const recommended = useMemo(() => recommendedOf(joinable), [joinable]);
  // Null until the person changes it: the recommended ones, whenever the list arrives.
  const [chosen, setChosen] = useState<ReadonlySet<string> | null>(null);
  const picked = chosen ?? recommended;
  const [joining, setJoining] = useState(false);
  const [failed, setFailed] = useState<{ readonly names: string; readonly why: string } | null>(
    null,
  );

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
    setFailed(null);
    const wanted = joinable.filter((c) => picked.has(c.id));
    const outcomes = await Promise.allSettled(wanted.map((c) => joinChannel(c.id)));
    const refused = wanted.filter((_, at) => outcomes[at]?.status === 'rejected');
    setJoining(false);
    if (refused.length === 0) {
      enter();
      return;
    }
    const first = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
    setChosen(new Set(refused.map((c) => c.id)));
    setFailed({
      names: refused.map((c) => `#${c.name ?? ''}`).join(', '),
      why: describe(first?.reason),
    });
  };

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
              <span id={`${channel.id}-about`} className="flex min-w-0 flex-col gap-1">
                <span className="flex items-center gap-2 font-mono text-body text-ink">
                  {`#${channel.name ?? ''}`}
                  {recommended.has(channel.id) && (
                    <span className="rounded-sm bg-accent-subtle px-1 font-sans text-caption text-accent-text">
                      {t('welcome.active')}
                    </span>
                  )}
                </span>
                {channel.topic !== null && (
                  <span className="truncate text-label text-ink-muted">{channel.topic}</span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
        {failed !== null && (
          <p role="alert" className="text-label text-danger-text">
            {`${t('welcome.failed', { names: failed.names })} ${failed.why}`}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary" busy={joining} disabled={picked.size === 0}>
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
          <p className="text-body text-ink-muted">{t('welcome.lede')}</p>
          {body}
        </section>
      </div>
    </>
  );
};
