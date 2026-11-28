/**
 * `/setup/verify#<token>` — the administrator's address link (D-179 §4.3, `API.md` §2). Public, and
 * works in any browser, with no claim: the link is the administrator's proof. The token leaves the
 * address bar as the page reads it (as a sign-in link's does) and is posted once; `useQuery` is the
 * once — a second render, or React's double effect in development, asks the same question and is
 * given the same answer, where a second post would find the link spent and say it was refused.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { Button, buttonStyle } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { browserInvitationPorts } from '../invitations/pending';
import { Notice } from '../../ui/notice';
import { createSetupClient, isSetupFailure, type SetupClient } from './client';
import { failureWords } from './errors';
import { StandaloneCard, StandaloneScreen } from '../shell/standalone';

const FRAGMENT = /^#([0-9a-f]{64})$/;

/** The link's token, or nothing for a fragment that is not one. */
export const readVerifyLink = (hash: string): string | null => FRAGMENT.exec(hash)?.[1] ?? null;

/** Every answer is a notice, in the notice's card (`sign-in/door-card`): its glyph says which, and no mark above it. */
const Card = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <StandaloneScreen>
    <StandaloneCard>{children}</StandaloneCard>
  </StandaloneScreen>
);

export const VerifyScreen = ({ client }: { readonly client?: SetupClient }): React.JSX.Element => {
  const { t } = useI18n();
  const real = useMemo(
    () => client ?? createSetupClient((input, init) => fetch(input, init)),
    [client],
  );
  const [token] = useState(() => readVerifyLink(window.location.hash));
  const ports = useMemo(browserInvitationPorts, []);

  // The secret leaves the address bar, the history and any screen being shared.
  useEffect(() => {
    if (window.location.hash !== '') ports.replace(href('setupVerify'));
  }, [ports]);

  const answer = useQuery({
    // A constant: the token is a secret, and a query key is shown by devtools and kept in the cache.
    queryKey: ['setup', 'verify'],
    queryFn: async () => await real.verify(token ?? ''),
    enabled: token !== null,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // Verified, the way on is signing in; refused or incomplete, it is still the one place to go from here.
  const signIn = (variant: 'primary' | 'secondary'): React.JSX.Element => (
    <a href={href('signIn')} className={buttonStyle(variant)}>
      {t('setup.verify.done.action')}
    </a>
  );

  if (token === null) {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="warning"
          title={t('setup.verify.incomplete.title')}
          body={t('setup.verify.incomplete.body')}
          action={signIn('secondary')}
        />
      </Card>
    );
  }
  if (answer.isPending) {
    return (
      <Card>
        <LoadingStatus label={t('setup.verify.loading')} className="flex w-full flex-col gap-3 p-8">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      </Card>
    );
  }
  if (answer.isSuccess) {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="resolved"
          title={t('setup.verify.done.title')}
          body={t('setup.verify.done.body')}
          action={signIn('primary')}
        />
      </Card>
    );
  }
  const failure = answer.error;
  if (isSetupFailure(failure) && failure.status === 404) {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="warning"
          title={t('setup.verify.refused.title')}
          body={t('setup.verify.refused.body')}
          action={signIn('secondary')}
        />
      </Card>
    );
  }
  const words = isSetupFailure(failure) ? failureWords(failure) : null;
  return (
    <Card>
      <Notice
        as="h1"
        glyph="failed"
        title={t('setup.verify.error.title')}
        body={
          words?.kind === 'rate'
            ? t('setup.failed.rate', { count: words.minutes })
            : t(words?.kind === 'plain' ? words.key : 'setup.failed.generic')
        }
        action={
          <Button
            onClick={() => {
              void answer.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        }
      />
    </Card>
  );
};
