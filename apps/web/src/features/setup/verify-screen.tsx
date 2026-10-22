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
import { buttonStyle } from '../../ui/button';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { browserInvitationPorts } from '../invitations/pending';
import { LogoMark, Notice } from '../shell/notice';
import { createSetupClient, isSetupFailure, type SetupClient } from './client';
import { failureWords } from './errors';

const FRAGMENT = /^#([0-9a-f]{64})$/;

/** The link's token, or nothing for a fragment that is not one. */
export const readVerifyLink = (hash: string): string | null => FRAGMENT.exec(hash)?.[1] ?? null;

const Card = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
    <div className="flex w-full max-w-dialog flex-col items-center gap-4 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 text-center shadow-card">
      <LogoMark />
      {children}
    </div>
  </Main>
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

  const signIn = (
    <a href={href('signIn')} className={buttonStyle('primary', 'lg')}>
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
        />
      </Card>
    );
  }
  if (answer.isPending) {
    return (
      <Card>
        <LoadingStatus label={t('setup.verify.loading')} className="flex w-full flex-col gap-3">
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
          action={signIn}
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
