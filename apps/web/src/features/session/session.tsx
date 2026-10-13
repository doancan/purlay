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
 */
import { createContext, useContext, useEffect } from 'react';
import { AppSkeleton } from '../../app/skeleton';
import { isApiError } from '../../data/errors';
import { useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { ErrorState } from '../../ui/states';
import { PushProvider } from '../push/push';
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
  const { navigate } = useRoute();
  const { t } = useI18n();
  const signedOut = me.isError && isApiError(me.error) && me.error.status === 401;

  useEffect(() => {
    if (signedOut) navigate(href('signIn'), { replace: true });
  }, [signedOut, navigate]);

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
  // Push is a person's, on every signed-in page: a device they turned it on in is tied again on load.
  return (
    <SessionContext.Provider value={me.data}>
      <PushProvider userId={me.data.user.id}>{children}</PushProvider>
    </SessionContext.Provider>
  );
};
