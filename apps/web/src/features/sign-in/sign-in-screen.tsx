/**
 * Sign in. The organisation's single sign-on where a provider is connected (D-200), GitHub where the server
 * has an app connected, the address and password unless the server's administrator turned passwords off (the
 * setup's administrator has one, R30; D-239), and a link by email where the server can send one (D-138, D-179): the
 * screen offers what `/api/auth/methods` says works and nothing it assumes. Under it, "Create an
 * account" where sign-up is open and a plain "by invitation" where it is not (R51). A server with neither
 * GitHub nor mail is waiting for its setup (D-179 §4), and says so plainly above the password. When the
 * server could not be asked, the screen keeps the historical default — the GitHub button — and says so in
 * one small line with a retry: the server answers a button it should not have offered with a defined 404
 * (R45); the password form does not depend on the answer and stays. The GitHub
 * click is a full navigation — the server answers with a redirect to GitHub and the callback
 * lands back on this origin with a session cookie, none of which a router can do.
 *
 * Already signed in is not a reason to look at this page: the identity is asked for
 * quietly and a person who has one is sent on. `?reason=ended` is how the client
 * explains that it got here because the session ended, and `?error=<reason>` is how the
 * API says why the round trip through GitHub did not finish — one sentence per reason in
 * `SignInFailure` (D-121); each says what to do, none blames.
 *
 * It is the first thing anyone sees of the product, so it is a card on the navigation tone with the
 * product's mark, not a heading on a blank page (D-100).
 */
import { InstanceIdentity } from '../session/admission';
import { lazy, Suspense, useEffect, useState } from 'react';
import { signInFailureIn, type SignInFailure } from '@purlay/types';
import { useAuthMethods, useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href, workspaceAccessHref } from '../../router/routes';
import { Link, useRoute } from '../../router/router-provider';
import { Button, buttonStyle } from '../../ui/button';
import { Disclosure } from '../../ui/disclosure';
import { cn } from '../../ui/cn';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { browserNativePorts, nativeAppName, pendingNativeHandoff } from '../native/pending';
import { LogoMark } from '../../ui/notice';
import { EmailSignInForm } from './email-sign-in-form';
import { GitHubButton } from './github-button';
import { GoogleButton } from './google-button';
import { OidcButton } from './oidc-button';
import { DoorCard } from './door-card';

const CompanySignIn = lazy(async () => ({
  default: (await import('./company-sign-in')).CompanySignIn,
}));

type SentenceKey =
  | 'signIn.cancelled'
  | 'signIn.expired'
  | 'signIn.emailRequired'
  | 'signIn.emailTaken'
  | 'signIn.emailTakenNoMail'
  | 'signIn.signupClosed'
  | 'signIn.domainNotAllowed'
  | 'signIn.githubUnavailable'
  | 'signIn.oidcUnavailable'
  | 'signIn.googleUnavailable'
  | 'signIn.emailUnverified'
  | 'signIn.busy'
  | 'signIn.failed';

/**
 * The sentence for a reason, given whether the email form is on the screen. A `switch` with no
 * default, so a reason added to the contract is a compile error here; and a reason whose words depend
 * on the form (`email-taken` points at it, or at an administrator where it is not) says both
 * variants in one place, never an instruction the screen contradicts.
 */
const sentenceFor = (failure: SignInFailure, mail: boolean): SentenceKey => {
  switch (failure) {
    case 'cancelled':
      return 'signIn.cancelled';
    case 'expired':
      return 'signIn.expired';
    case 'email-required':
      return 'signIn.emailRequired';
    case 'email-taken':
      return mail ? 'signIn.emailTaken' : 'signIn.emailTakenNoMail';
    case 'email-domain-not-allowed':
      return 'signIn.domainNotAllowed';
    case 'signup-closed':
      return 'signIn.signupClosed';
    case 'github-unavailable':
      return 'signIn.githubUnavailable';
    case 'oidc-unavailable':
      return 'signIn.oidcUnavailable';
    case 'google-unavailable':
      return 'signIn.googleUnavailable';
    case 'email-unverified':
      return 'signIn.emailUnverified';
    case 'busy':
      return 'signIn.busy';
    case 'failed':
      return 'signIn.failed';
  }
};

export const SignInScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { search, navigate } = useRoute();
  const me = useMe();
  const methods = useAuthMethods();
  const parameters = new URLSearchParams(search);
  const independent = parameters.get('independent') === '1';
  const workspace = parameters.get('workspace') ?? '';
  // Each is offered only once the server has said it works (`EmailSignInForm` asks for itself).
  const mail = methods.data?.email === true;
  const github = methods.data?.github === true;
  const google = methods.data?.google === true;
  const oidc = methods.data?.oidc ?? null;
  // The native application sent the person here and is waiting for their answer (D-191): say so.
  const [native] = useState(() => pendingNativeHandoff(browserNativePorts(), window.location));
  const failure = signInFailureIn(search);
  const reason = new URLSearchParams(search).get('reason');
  const note =
    failure !== null
      ? t(sentenceFor(failure, mail))
      : reason === 'ended'
        ? t('signIn.ended')
        : reason === 'erased'
          ? t('signIn.erased')
          : null;

  useEffect(() => {
    if (
      me.isSuccess &&
      me.data.companyWorkspaceId === undefined &&
      !independent &&
      workspace === ''
    )
      navigate(href('home'), { replace: true });
  }, [me.isSuccess, me.data?.companyWorkspaceId, independent, workspace, navigate]);

  return (
    <DoorCard>
      <LogoMark />
      <InstanceIdentity />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-balance text-display">{t('signIn.title')}</h1>
        <p className="text-balance text-body text-ink-muted">{t('signIn.lede')}</p>
        {native !== null && (
          <p className="text-balance text-label text-ink-muted">
            {t('signIn.native', { app: nativeAppName(native.platform) })}
          </p>
        )}
      </div>
      {/* Why the person is here again is a sentence of its own, not a line of the heading: it can run to four. */}
      {note !== null && (
        <p
          role="status"
          className="w-full text-pretty rounded-md bg-warning-subtle px-3 py-2 text-left text-label font-normal text-warning-text"
        >
          {note}
        </p>
      )}
      {methods.data === undefined && !methods.isError ? (
        <LoadingStatus label={t('common.loading')} className="flex w-full flex-col gap-3">
          <Skeleton className="h-control w-full rounded-md max-narrow:h-touch" />
        </LoadingStatus>
      ) : (
        <>
          {!methods.isError &&
            !github &&
            !google &&
            oidc === null &&
            !mail &&
            methods.data.company === undefined && (
              <div className="flex w-full flex-col items-center gap-3">
                <h2 className="text-title">{t('signIn.notSetUp.title')}</h2>
                <p className="text-balance text-body text-ink-muted">{t('signIn.notSetUp.body')}</p>
                <a href={href('setup')} className={cn(buttonStyle('secondary'), 'w-full')}>
                  {t('signIn.notSetUp.action')}
                </a>
              </div>
            )}
          {/* The address and password lead: it is what most people came to type. Single sign-on and the
              company's door sit under it, the second closed until it is asked for. */}
          <EmailSignInForm
            alone
            withPassword={methods.data?.password !== false}
            mail={mail}
            {...(workspace === ''
              ? {}
              : {
                  onSignedIn: (): void => {
                    navigate(workspaceAccessHref(workspace), { replace: true });
                  },
                })}
          />
          {(oidc !== null || github || google || methods.isError) && (
            <>
              <p
                aria-hidden="true"
                className="flex w-full items-center gap-3 text-caption text-ink-muted before:flex-1 before:border-t-hairline before:border-border-subtle after:flex-1 after:border-t-hairline after:border-border-subtle"
              >
                {t('signIn.or')}
              </p>
              <div className="flex w-full flex-col items-center gap-3">
                {oidc !== null && <OidcButton name={oidc.name} variant="secondary" />}
                {(github || methods.isError) && (
                  <>
                    <GitHubButton variant="secondary" />
                    <p className="text-balance text-caption text-ink-muted">{t('signIn.scope')}</p>
                  </>
                )}
                {google && <GoogleButton variant="secondary" />}
              </div>
            </>
          )}
          {methods.data?.company !== undefined && !independent && (
            <Disclosure
              open={workspace !== ''}
              className="w-full text-left text-label"
              summary={t('company.signIn.title')}
            >
              <Suspense
                fallback={
                  <LoadingStatus label={t('common.loading')} className="w-full">
                    <Skeleton />
                  </LoadingStatus>
                }
              >
                <CompanySignIn key={workspace} initialWorkspace={workspace} bare />
              </Suspense>
            </Disclosure>
          )}
          {methods.isError && (
            <p className="flex flex-wrap items-center justify-center gap-x-1 text-balance text-caption text-ink-muted">
              {t('signIn.methods.unchecked')}
              <Button
                variant="secondary"
                onClick={() => {
                  void methods.refetch();
                }}
              >
                {t('signIn.methods.retry')}
              </Button>
            </p>
          )}
          {methods.data?.signUp === 'open' && (
            <p className="text-balance text-label text-ink-muted">
              {t('signIn.createAccount.prompt')}{' '}
              <Link to="signUp" className="text-accent-text underline">
                {t('signIn.createAccount.action')}
              </Link>
            </p>
          )}
          {methods.data?.signUp === 'invite-only' && (
            <p className="text-balance text-label text-ink-muted">{t('signIn.byInvitation')}</p>
          )}
        </>
      )}
    </DoorCard>
  );
};
