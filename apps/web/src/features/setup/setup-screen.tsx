/**
 * `/setup` — the wizard (D-179 §4, `UX.md` §11): a navy list of the steps and the step beside it, one
 * column on a narrow window with the list reduced to *Step n of 8*.
 *
 * **What it asks of the server, and how often.** `GET /setup/status` once, on entry — it shares the
 * sign-in rate-limit bucket — and `GET /setup/state` once, then again only after a step changed
 * something: never on a timer, never when the window is focused. The browser can be closed and
 * reopened; the cookie holds the setup, and the page resumes at the first screen the server has not
 * passed. A screen already passed can be walked back to and shows what was kept.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SetupState } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useMe, useSetupStatus } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { buttonStyle } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Main } from '../../ui/main';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { ErrorState } from '../../ui/states';
import { LogoMark, Notice } from '../shell/notice';
import { createSetupClient, isSetupFailure, type SetupClient } from './client';
import { SETUP_STATE_KEY, SetupProvider } from './context';
import { movementClass, useReducedMotion } from './motion';
import { NAMES, passed, resumeAt, SCREENS, type Screen } from './screens';
import { AddressStep } from './steps/address-step';
import { AdminStep } from './steps/admin-step';
import { ClaimStep } from './steps/claim-step';
import { EmailStep } from './steps/email-step';
import { FinishStep } from './steps/finish-step';
import { GitHubStep } from './steps/github-step';
import { InviteStep } from './steps/invite-step';
import type { StepProps } from './steps/props';
import { WorkspaceStep } from './steps/workspace-step';

const Stepper = ({
  current,
  state,
  settled,
}: {
  readonly current: number;
  readonly state: SetupState | null;
  /** The screen whose mark just turned done, if one did: it settles. */
  readonly settled: number | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  return (
    <aside className="flex w-sidebar shrink-0 flex-col gap-8 bg-nav-rail p-6 text-nav-ink max-narrow:hidden">
      <div className="flex items-center gap-3 text-title">
        <LogoMark />
        <span>{t('setup.title')}</span>
      </div>
      <nav aria-label={t('setup.stepper.label')} className="flex-1">
        <ol className="flex flex-col">
          {SCREENS.map((screen, index) => {
            const done = index < current && (screen === 'claim' || passed(state, screen));
            const now = index === current;
            return (
              <li
                key={screen}
                aria-current={now ? 'step' : undefined}
                className="relative flex gap-3 pb-4"
              >
                {index < SCREENS.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute left-3 top-6 bottom-0 border-l-hairline border-nav-border"
                  />
                )}
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative inline-flex size-6 shrink-0 items-center justify-center rounded-pill border-hairline text-caption',
                    done && 'border-success bg-success text-on-status',
                    now && 'border-accent bg-accent text-on-accent',
                    !done && !now && 'border-nav-border bg-nav-rail text-nav-ink-muted',
                    done && settled === index && movementClass('mark-settle', reduced),
                  )}
                >
                  {done ? <Icon name="confirm" size="sm" /> : index + 1}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn('text-label', !done && !now && 'text-nav-ink-muted')}>
                    {t(NAMES[screen].name)}
                  </span>
                  <span className="text-caption text-nav-ink-muted">{t(NAMES[screen].line)}</span>
                  {done && <VisuallyHidden>{t('setup.done')}</VisuallyHidden>}
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
      <p className="border-t-hairline border-nav-border pt-4 text-caption text-nav-ink-muted">
        {t('setup.foot')}
      </p>
    </aside>
  );
};

const Shell = ({
  children,
  stepper,
}: {
  readonly children: React.ReactNode;
  readonly stepper?: React.ReactNode;
}): React.JSX.Element => (
  <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-6 text-ink max-narrow:p-0">
    <div className="flex w-full max-w-settings self-center overflow-hidden rounded-xl border-hairline border-border-subtle bg-surface-100 shadow-raised max-narrow:min-h-screen max-narrow:flex-col max-narrow:rounded-none max-narrow:border-transparent">
      {stepper}
      {children}
    </div>
  </Main>
);

/**
 * A finished server's answer to `/setup`: sign-in for someone who is not, and the app itself for
 * someone who is (`UX.md` §11). Asked of `/api/me` only here, once the server has said it is closed;
 * until it answers, or when it cannot, the link is the sign-in one — it is never wrong to offer.
 */
const ClosedNotice = (): React.JSX.Element => {
  const { t } = useI18n();
  const me = useMe();
  const signedIn = me.data !== undefined;
  return (
    <Notice
      as="h1"
      glyph="resolved"
      title={t('setup.closed.title')}
      body={signedIn ? t('setup.closed.bodySignedIn') : t('setup.closed.body')}
      action={
        <a href={href(signedIn ? 'home' : 'signIn')} className={buttonStyle('primary', 'lg')}>
          {signedIn ? t('setup.closed.open') : t('setup.closed.action')}
        </a>
      }
    />
  );
};

export const SetupScreen = ({ client }: { readonly client?: SetupClient }): React.JSX.Element => {
  const { t } = useI18n();
  const reduced = useReducedMotion();
  const queries = useQueryClient();
  const real = useMemo(
    () => client ?? createSetupClient((input, init) => fetch(input, init)),
    [client],
  );
  const status = useSetupStatus();
  const open = status.data?.open === true;
  const [lost, setLost] = useState(false);

  // The state, read once and after a step changed something: no timer, no refetch on focus.
  const state = useQuery({
    queryKey: SETUP_STATE_KEY,
    queryFn: async ({ signal }) => await real.state(signal),
    enabled: open,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: false,
  });

  const onLost = useCallback((): void => {
    setLost(true);
    void queries.invalidateQueries({ queryKey: SETUP_STATE_KEY });
  }, [queries]);

  // Held by this browser or not: a refusal is `404 SETUP_UNAVAILABLE`, and means "ask for the code".
  const unheld = state.isError && isSetupFailure(state.error) && state.error.status === 404;
  const held: SetupState | null = state.data ?? null;
  const resume = unheld ? 0 : resumeAt(held);

  // Walking back over screens already passed: valid only while the server has not moved on.
  const [view, setView] = useState<{ readonly index: number; readonly from: number } | null>(null);
  const current = view !== null && view.from === resume ? view.index : resume;

  // Which way the last change went, and which mark just turned done.
  const [shown, setShown] = useState({
    index: current,
    back: false,
    settled: null as number | null,
  });
  if (shown.index !== current) {
    setShown({
      index: current,
      back: current < shown.index,
      settled: current > shown.index ? shown.index : null,
    });
  }

  // Focus follows the step: the new step's heading, never as the page first opens.
  const content = useRef<HTMLDivElement>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    content.current?.querySelector<HTMLElement>('[data-step-heading]')?.focus();
  }, [current]);

  if (status.isPending || (open && state.isPending)) {
    return (
      <Shell>
        <LoadingStatus label={t('common.loading')} className="flex flex-1 flex-col gap-3 p-10">
          <Skeleton className="w-sidebar" />
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      </Shell>
    );
  }
  if (status.isError) {
    return (
      <Shell>
        <ErrorState
          title={t('setup.status.error.title')}
          body={t('setup.status.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void status.refetch();
          }}
        />
      </Shell>
    );
  }
  if (!open) {
    return (
      <Shell>
        <ClosedNotice />
      </Shell>
    );
  }
  if (state.isError && !unheld) {
    return (
      <Shell>
        <ErrorState
          title={t('setup.state.error.title')}
          body={t('setup.state.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void state.refetch();
          }}
        />
      </Shell>
    );
  }

  const screen: Screen = SCREENS[current] ?? SCREENS[0];
  const goTo = (target: Screen): void => {
    setView({ index: SCREENS.indexOf(target), from: resume });
  };
  const step = (): React.JSX.Element => {
    if (screen === 'claim' || held === null) {
      return <ClaimStep appUrl={status.data.appUrl} lost={lost} />;
    }
    const props: StepProps = {
      state: held,
      done: passed(held, screen),
      onBack:
        current <= 1
          ? null
          : (): void => {
              setView({ index: current - 1, from: resume });
            },
      onNext: () => {
        setView({ index: Math.min(current + 1, resume), from: resume });
      },
      goTo,
    };
    switch (screen) {
      case 'admin':
        return <AdminStep {...props} />;
      case 'address':
        return <AddressStep {...props} />;
      case 'github':
        return <GitHubStep {...props} />;
      case 'email':
        return <EmailStep {...props} />;
      case 'workspace':
        return <WorkspaceStep {...props} />;
      case 'invite':
        return <InviteStep {...props} />;
      case 'finish':
        return <FinishStep {...props} />;
    }
  };

  return (
    <SetupProvider client={real} onLost={onLost}>
      <Shell stepper={<Stepper current={current} state={held} settled={shown.settled} />}>
        <section className="flex min-w-0 flex-1 flex-col gap-6 p-10 max-narrow:p-6">
          <div className="hidden items-center gap-3 text-title max-narrow:flex">
            <LogoMark />
            <span>{t('setup.title')}</span>
          </div>
          <p className="text-label text-accent-text">
            {t('setup.stepOf', { n: current + 1, total: SCREENS.length })}
          </p>
          <div
            ref={content}
            key={screen}
            className={movementClass(shown.back ? 'step-back' : 'step-in', reduced)}
          >
            {step()}
          </div>
        </section>
      </Shell>
    </SetupProvider>
  );
};
