/**
 * `/sign-up` — making an account, where the server lets anybody (`signUp: 'open'`, R51): GitHub, or a
 * link by email whose first spend makes the account. There is no password sign-up: the library's is
 * closed (D-179 §3), and a password is for the administrator the setup made. Where sign-up is by
 * invitation the screen says so and points to sign-in; it never asks the server to refuse a form it
 * should not have shown.
 */
import { useAuthMethods, useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { Link, useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { LogoMark } from '../shell/notice';
import { useEffect } from 'react';
import { EmailSignInForm } from './email-sign-in-form';
import { GitHubButton } from './github-button';

export const SignUpScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { navigate } = useRoute();
  const me = useMe();
  const methods = useAuthMethods();
  const github = methods.data?.github === true;
  const mail = methods.data?.email === true;
  const open = methods.data?.signUp === 'open';

  useEffect(() => {
    if (me.isSuccess) navigate(href('home'), { replace: true });
  }, [me.isSuccess, navigate]);

  const signIn = (
    <p className="text-balance text-label text-ink-muted">
      {t('signUp.haveAccount')}{' '}
      <Link to="signIn" className="text-accent-text underline">
        {t('signUp.signIn')}
      </Link>
    </p>
  );

  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <section className="flex w-full max-w-dialog flex-col items-center gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 px-8 py-10 text-center shadow-card max-narrow:px-6 max-narrow:py-8">
        <LogoMark />
        {methods.isError ? (
          <>
            <h1 className="text-display">{t('signUp.title')}</h1>
            <p className="flex flex-wrap items-center justify-center gap-x-1 text-balance text-body text-ink-muted">
              {t('signIn.methods.unchecked')}
              <Button
                variant="ghost"
                onClick={() => {
                  void methods.refetch();
                }}
              >
                {t('signIn.methods.retry')}
              </Button>
            </p>
          </>
        ) : methods.data === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex w-full flex-col gap-3">
            <Skeleton className="h-touch w-full rounded-md" />
          </LoadingStatus>
        ) : !open ? (
          <>
            <div className="flex flex-col items-center gap-2">
              <h1 className="text-display">{t('signUp.closed.title')}</h1>
              <p className="text-balance text-body text-ink-muted">{t('signUp.closed.body')}</p>
            </div>
            {signIn}
          </>
        ) : !github && !mail ? (
          <>
            <div className="flex flex-col items-center gap-2">
              <h1 className="text-display">{t('signUp.title')}</h1>
              <p className="text-balance text-body text-ink-muted">{t('signUp.nothing')}</p>
            </div>
            {signIn}
          </>
        ) : (
          <>
            <div className="flex flex-col items-center gap-2">
              <h1 className="text-display">{t('signUp.title')}</h1>
              <p className="text-balance text-body text-ink-muted">{t('signUp.lede')}</p>
            </div>
            {github && (
              <div className="flex w-full flex-col items-center gap-3">
                <GitHubButton variant={mail ? 'secondary' : 'primary'} />
                <p className="text-balance text-caption text-ink-muted">{t('signIn.scope')}</p>
              </div>
            )}
            <EmailSignInForm alone={!github} mail={mail} />
            {signIn}
          </>
        )}
      </section>
    </Main>
  );
};
