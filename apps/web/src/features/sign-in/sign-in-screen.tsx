/**
 * Sign in. One button: GitHub is the only way in (`API.md` §2), and the click is a
 * full navigation — the server answers with a redirect to GitHub and the callback
 * lands back on this origin with a session cookie, none of which a router can do.
 *
 * Already signed in is not a reason to look at this page: the identity is asked for
 * quietly and a person who has one is sent on. `?reason=ended` is how the client
 * explains that it got here because the session ended, and `?error` that the round trip
 * did not finish; both say what to do, neither blames.
 */
import { useEffect } from 'react';
import { useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { buttonStyle } from '../../ui/button';
import { Main } from '../../ui/main';
import { Icon } from '../../components/icon';

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
    <Main className="flex min-h-screen flex-col items-start justify-center gap-6 bg-surface-100 px-8 text-ink">
      <section className="flex max-w-feed flex-col gap-3">
        <h1 className="text-display">{t('signIn.title')}</h1>
        <p className="text-body text-ink-muted">{t('signIn.lede')}</p>
        {note !== null && (
          <p role="status" className="text-label text-warning-text">
            {note}
          </p>
        )}
      </section>
      <div className="flex flex-col gap-2">
        {/* A plain anchor on purpose: the browser must leave this page. */}
        <a href="/auth/github" className={buttonStyle('primary')}>
          <Icon name="confirm" />
          {t('signIn.github')}
        </a>
        <p className="max-w-feed text-caption text-ink-muted">{t('signIn.scope')}</p>
      </div>
    </Main>
  );
};
