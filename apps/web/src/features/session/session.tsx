/**
 * Who is signed in — or the sign-in screen, or an error that can be retried.
 *
 * Everything past this gate may assume a person: it renders nothing of the
 * application until `GET /api/me` has answered, and answers three ways. *Signed in*
 * hands the identity down. *Not signed in* (a 401, the one code that means it) takes
 * the browser to the sign-in screen with `replace`, so Back does not return to a
 * page that would only bounce again. *Anything else* is a failure of the server or
 * the network, which is not the same as being signed out and must not look like it:
 * it says so, and offers Retry.
 *
 * *Signed in, but held back* — the server requires two-step verification of the person's account and it is
 * off (D-239) — draws nothing of the application either, only the screen that turns it on: every other route
 * would answer `403 TWO_FACTOR_REQUIRED`. Turned on, the identity is read again and the gate lets the rest in.
 */
import { createContext, useContext, useEffect } from 'react';
import { AppSkeleton } from '../../app/skeleton';
import { isApiError } from '../../data/errors';
import { useMe, useSetupStatus } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { ErrorState } from '../../ui/states';
import { PushProvider } from '../push/push';
import { LazyTwoFactorEnrolment } from '../settings/load';
import type { MeResponse } from '@purlay/types';

const SessionContext = createContext<MeResponse | null>(null);

/** The person and their memberships. Only valid below `SessionGate`. */
export const useSession = (): MeResponse => {
  const session = useContext(SessionContext);
  if (session === null) throw new Error('useSession was called outside a SessionGate');
  return session;
};

export const SessionGate = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element | null => {
  const me = useMe();
  const { navigate, match } = useRoute();
  const { t } = useI18n();
  const signedOut = me.isError && isApiError(me.error) && me.error.status === 401;
  // Nobody signed in at `/` on a server nobody has set up: the wizard, not a sign-in card with
  // nothing behind it. Asked of the server once, and only here; a failed ask is "not open".
  const front = signedOut && me.data === undefined && match.name === 'home';
  const status = useSetupStatus(front);
  const open = status.data?.open === true;
  const deciding = front && status.isPending;
  // A session the page held, now refused, ended — and the sign-in screen says so (#693). A first
  // visit with none did not end anything, and is the plain screen.
  const ended = signedOut && me.data !== undefined;

  useEffect(() => {
    if (!signedOut || deciding) return;
    if (front && open) navigate(href('setup'), { replace: true });
    else navigate(ended ? `${href('signIn')}?reason=ended` : href('signIn'), { replace: true });
  }, [signedOut, ended, navigate, deciding, front, open]);

  if (me.isPending) return <AppSkeleton />;
  if (signedOut) return null;
  // A read that fails while the page already holds the person — a reconnect reads them again — keeps
  // the page: a passing 5xx is not a reason to tear down the shell and every composer. A 401 is the
  // end of the session, and goes to sign-in above whatever is held.
  if (me.isError && me.data === undefined) {
    return (
      <ErrorState
        title={t('state.session.error.title')}
        body={t('state.session.error.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void me.refetch();
        }}
      />
    );
  }
  if (me.data.mustEnrolTwoFactor) return <LazyTwoFactorEnrolment email={me.data.user.email} />;
  // Push is a person's, on every signed-in page: a device they turned it on in is tied again on load.
  return (
    <SessionContext.Provider value={me.data}>
      <PushProvider userId={me.data.user.id}>{children}</PushProvider>
    </SessionContext.Provider>
  );
};
