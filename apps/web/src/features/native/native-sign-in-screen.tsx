/**
 * `/sign-in/native` — the page the native application sends a person to, where, signed in, they say yes
 * (D-191, `UX.md` §11).
 *
 * It asks, and never decides: it names the account, its address and the server the application will be
 * signed in to, and only the button asks the server for a code — for the pair the application's own link
 * left in this tab, never for one this page was merely opened with. A page that made the code as it loaded
 * would hand an account to anybody who could send a link.
 *
 * Three ways on, because the first thing a shared or work-profile browser shows is the wrong person: the
 * button, **Cancel**, and signing this browser out to use another account (the pair waits through that, as
 * it waits through any sign-in). The answer is a redirect the server names, `purlay://…`, opened with a full
 * navigation; this tab stays on a card that says what to do next and can open the application again from
 * the same code, which lasts two minutes.
 *
 * Each card that replaces another puts focus on its button (`UX.md` §7).
 */
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { useSession } from '../session/session';
import { LogoMark, Notice } from '../shell/notice';
import { useSignOut } from '../shell/sign-out';
import { leave } from '../sign-in/leave';
import { browserNativePorts, forgetNativeHandoff, pendingNativeHandoff } from './pending';

const Card = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
    <div className="flex w-full max-w-dialog flex-col items-center gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 text-center shadow-card">
      {children}
    </div>
  </Main>
);

export const NativeSignInScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { user } = useSession();
  const { navigate } = useRoute();
  const describe = useDescribeFailure();
  const signOut = useSignOut();
  const ports = useMemo(browserNativePorts, []);
  // Read once, as the page opens: what the tab was asked, by whom it was asked, and not again.
  const [pair] = useState(() => pendingNativeHandoff(ports, window.location));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const [redirect, setRedirect] = useState<string | null>(null);
  const action = useRef<HTMLButtonElement>(null);
  const card = redirect !== null ? 'done' : pair === null ? 'gone' : 'ask';

  useEffect(() => {
    action.current?.focus();
  }, [card]);

  const home = (): void => {
    navigate(href('home'), { replace: true });
  };

  if (card === 'gone') {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="warning"
          title={t('native.gone.title')}
          body={t('native.gone.body')}
          action={
            <Button ref={action} variant="primary" onClick={home}>
              {t('native.gone.back')}
            </Button>
          }
        />
      </Card>
    );
  }

  if (card === 'done') {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="resolved"
          title={t('native.done.title')}
          body={t('native.done.body')}
          action={
            <Button
              ref={action}
              onClick={() => {
                leave.to(redirect ?? '');
              }}
            >
              {t('native.done.again')}
            </Button>
          }
        />
      </Card>
    );
  }

  const authorize = async (): Promise<void> => {
    // Unreachable — the card with this button needs a pair — but the compiler cannot see the card.
    if (pair === null) return;
    setBusy(true);
    setFailed(null);
    try {
      const answer = await api.authorizeNative(pair);
      // Spent: asking again would make a second code for a question that has been answered.
      forgetNativeHandoff(ports);
      setRedirect(answer.redirect);
      leave.to(answer.redirect);
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.status === 401) {
        // The session ended while the page was open. What the page believes of it is stale, so ask again:
        // the gate takes the person to sign in, and the pair is still here after.
        void client.invalidateQueries({ queryKey: keys.me });
        return;
      }
      setFailed(failure);
    }
  };

  return (
    <Card>
      <LogoMark />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-display">{t('native.title')}</h1>
        <p className="text-body text-ink-muted">
          {t('native.body', {
            name: user.displayName,
            email: user.email,
            host: window.location.host,
          })}
        </p>
        <p className="text-label text-ink-muted">{t('native.hint')}</p>
      </div>
      {failed !== null && (
        <p role="alert" className="text-label text-danger-text">
          {`${t('native.failed')} ${describe(failed)}`}
        </p>
      )}
      <div className="flex w-full flex-col gap-2">
        <Button
          ref={action}
          variant="primary"
          busy={busy}
          className="w-full"
          onClick={() => {
            void authorize();
          }}
        >
          {failed === null ? t('native.authorize') : t('common.retry')}
        </Button>
        <Button
          className="w-full"
          onClick={() => {
            forgetNativeHandoff(ports);
            home();
          }}
        >
          {t('common.cancel')}
        </Button>
        <Button
          variant="ghost"
          className="w-full"
          onClick={() => {
            signOut('here');
          }}
        >
          {t('native.other')}
        </Button>
      </div>
    </Card>
  );
};
