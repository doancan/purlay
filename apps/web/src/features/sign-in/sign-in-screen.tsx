/**
 * Sign in. One button: GitHub is the only way in (`API.md` §2), and the click is a
 * full navigation — the server answers with a redirect to GitHub and the callback
 * lands back on this origin with a session cookie, none of which a router can do.
 *
 * Already signed in is not a reason to look at this page: the identity is asked for
 * quietly and a person who has one is sent on. `?reason=ended` is how the client
 * explains that it got here because the session ended, and `?error` that the round trip
 * did not finish; both say what to do, neither blames.
 *
 * It is the first thing anyone sees of the product, so it is a card on the navigation tone with the
 * product's mark, not a heading on a blank page (D-100).
 */
import { useEffect } from 'react';
import { useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { buttonStyle } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Main } from '../../ui/main';
import { Icon } from '../../components/icon';
import { LogoMark } from '../shell/notice';

export const SignInScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { search, navigate } = useRoute();
  const me = useMe();
  const params = new URLSearchParams(search);
  const note = params.has('error')
    ? t('signIn.failed')
    : params.get('reason') === 'ended'
      ? t('signIn.ended')
      : null;

  useEffect(() => {
    if (me.isSuccess) navigate(href('home'), { replace: true });
  }, [me.isSuccess, navigate]);

  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <section className="flex w-full max-w-dialog flex-col items-center gap-6 rounded-lg text-center bg-surface-100 p-8 shadow-card">
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
      </section>
    </Main>
  );
};
