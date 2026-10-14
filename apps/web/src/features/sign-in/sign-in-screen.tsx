/**
 * Sign in. GitHub always, and a link by email where the server can send one (D-138); the GitHub
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
import { useEffect } from 'react';
import { signInFailureIn, type SignInFailure } from '@purlay/types';
import type { MessageKey } from '../../i18n/types';
import { useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { buttonStyle } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Main } from '../../ui/main';
import { Icon } from '../../components/icon';
import { LogoMark } from '../shell/notice';
import { EmailSignInForm } from './email-sign-in-form';

/** The sentence for each reason. A `Record`, so a reason added to the contract is a compile error here. */
const FAILURE_SENTENCE = {
  cancelled: 'signIn.cancelled',
  expired: 'signIn.expired',
  'email-required': 'signIn.emailRequired',
  'email-taken': 'signIn.emailTaken',
  'github-unavailable': 'signIn.githubUnavailable',
  busy: 'signIn.busy',
  failed: 'signIn.failed',
} as const satisfies Readonly<Record<SignInFailure, MessageKey>>;

export const SignInScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { search, navigate } = useRoute();
  const me = useMe();
  const failure = signInFailureIn(search);
  const reason = new URLSearchParams(search).get('reason');
  const note =
    failure !== null
      ? t(FAILURE_SENTENCE[failure])
      : reason === 'ended'
        ? t('signIn.ended')
        : reason === 'erased'
          ? t('signIn.erased')
          : null;

  useEffect(() => {
    if (me.isSuccess) navigate(href('home'), { replace: true });
  }, [me.isSuccess, navigate]);

  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <section className="flex w-full max-w-dialog flex-col items-center gap-6 rounded-2xl border-hairline border-border-subtle text-center bg-surface-100 p-8 shadow-card">
        <LogoMark />
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-display">{t('signIn.title')}</h1>
          <p className="text-body text-ink-muted">{t('signIn.lede')}</p>
          {note !== null && (
            <p role="status" className="text-label text-warning-text">
              {note}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col items-center gap-3">
          {/* A plain anchor on purpose: the browser must leave this page. */}
          <a href="/auth/github" className={cn(buttonStyle('primary'), 'w-full')}>
            <Icon name="person" />
            {t('signIn.github')}
          </a>
          <p className="text-caption text-ink-muted">{t('signIn.scope')}</p>
        </div>
        <EmailSignInForm />
      </section>
    </Main>
  );
};
