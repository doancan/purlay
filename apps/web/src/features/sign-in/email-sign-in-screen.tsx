/**
 * `/sign-in/email#<token>` — a sign-in link opened (D-138 §4). The token leaves the address as the page
 * reads it, as an invitation's does (D-115); the page shows the address the link was sent to, and only
 * **Sign in** spends it, so a mail scanner that opens the page signs nobody in, and somebody sent a link
 * they did not ask for sees whose it is before using it.
 *
 * An invitation that rode in the link (`<token>.<invitation>`) is kept for this tab once the person is
 * in, and the home screen takes them to it, as after a GitHub sign-in. Somebody already signed in on
 * this page is told the link signs them in as someone else, and what the page kept of them is
 * forgotten as on sign-out. Each card that replaces another puts focus on its button (`UX.md` §7).
 */
import { useQuery } from '@tanstack/react-query';
import { NATIVE_CHALLENGE_PATTERN, NATIVE_STATE_PATTERN } from '@purlay/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { LogoMark, Notice } from '../shell/notice';
import { browserInvitationPorts, keepInvitation } from '../invitations/pending';
import { browserNativePorts, keepNativeHandoff, type NativeHandoff } from '../native/pending';

// `<token>`, then `.<invitation>` if one rode along, then `~<challenge>~<state>` if the native application
// asked (D-191). The pair is written by the server with the contract's patterns and read with the same.
const FRAGMENT = new RegExp(
  `^#([0-9a-f]{64})(?:\\.([0-9a-f]{64}))?(?:~(${NATIVE_CHALLENGE_PATTERN.slice(1, -1)})~(${NATIVE_STATE_PATTERN.slice(1, -1)}))?$`,
);

/**
 * The link's token, the invitation it carried and the native application's pair — or nothing, for a
 * fragment that is not one. A pair is both words or neither: half of one is not a link.
 */
export const readSignInLink = (
  hash: string,
): {
  readonly token: string;
  readonly invitation: string | null;
  readonly native: NativeHandoff | null;
} | null => {
  const match = FRAGMENT.exec(hash);
  if (match?.[1] === undefined) return null;
  const [, token, invitation, challenge, state] = match;
  return {
    token,
    invitation: invitation ?? null,
    native: challenge !== undefined && state !== undefined ? { challenge, state } : null,
  };
};

const notFound = (failure: unknown): boolean =>
  isApiError(failure) && failure.code === 'SIGN_IN_LINK_NOT_FOUND';

const Card = ({ children }: { readonly children: React.ReactNode }): React.JSX.Element => (
  <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
    <div className="flex w-full max-w-dialog flex-col items-center gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 text-center shadow-card">
      {children}
    </div>
  </Main>
);

export const EmailSignInScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { signInByLink } = useActions();
  const me = useMe();
  const { navigate } = useRoute();
  const describe = useDescribeFailure();
  const [link] = useState(() => readSignInLink(window.location.hash));
  const [signingIn, setSigningIn] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  const ports = useMemo(browserInvitationPorts, []);
  // The button of whichever card is showing; focused when one card replaces another.
  const action = useRef<HTMLButtonElement>(null);

  // The secret leaves the address bar, the history and any screen being shared.
  useEffect(() => {
    if (window.location.hash !== '') ports.replace(href('signInEmail'));
  }, [ports]);

  const preview = useQuery({
    queryKey: keys.emailSignIn(link?.token ?? ''),
    queryFn: async ({ signal }) => await api.previewEmailSignIn(link?.token ?? '', signal),
    enabled: link !== null,
    // A refusal is an answer; anything else the person retries by hand.
    retry: false,
  });

  const kind =
    link === null || notFound(preview.error) || notFound(failed)
      ? 'gone'
      : preview.isError
        ? 'failed'
        : preview.data === undefined
          ? 'reading'
          : 'ready';
  const shown = useRef(kind);
  useEffect(() => {
    // Not as the page opens on a card: only when one replaces another, or a failure is said.
    if (shown.current === kind && failed === null) return;
    shown.current = kind;
    action.current?.focus();
  }, [kind, failed]);

  const back = (
    <Button
      ref={action}
      variant="primary"
      onClick={() => {
        navigate(href('signIn'), { replace: true });
      }}
    >
      {t('signIn.link.back')}
    </Button>
  );

  if (kind === 'gone') {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="warning"
          title={t('signIn.title')}
          body={link === null ? t('signIn.link.missing') : t('signIn.link.notFound')}
          action={back}
        />
      </Card>
    );
  }

  if (kind === 'failed') {
    return (
      <Card>
        <Notice
          as="h1"
          glyph="failed"
          title={t('signIn.link.failed')}
          body={describe(preview.error)}
          action={
            <Button
              ref={action}
              onClick={() => {
                void preview.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    );
  }

  if (kind === 'reading' || preview.data === undefined) {
    return (
      <Card>
        <LoadingStatus label={t('common.loading')} className="flex w-full flex-col gap-3">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      </Card>
    );
  }

  const signIn = async (): Promise<void> => {
    // Unreachable — the card with this button needs a link — but the compiler cannot see the card.
    if (link === null) return;
    setSigningIn(true);
    setFailed(null);
    try {
      await signInByLink(link.token);
      if (link.invitation !== null) keepInvitation(link.invitation, ports);
      // The link was asked for by the native application, and may have opened in another browser than the one
      // the application's session is waiting in: what it carried is this tab's now, and home goes on to the consent.
      // A tab that cannot keep it carries it in the address to the consent instead, where it is read from.
      if (link.native !== null && !keepNativeHandoff(link.native, browserNativePorts())) {
        const query = new URLSearchParams({
          challenge: link.native.challenge,
          state: link.native.state,
        });
        navigate(`${href('signInNative')}?${query.toString()}`, { replace: true });
        return;
      }
      navigate(href('home'), { replace: true });
    } catch (failure) {
      setSigningIn(false);
      setFailed(failure);
    }
  };

  return (
    <Card>
      <LogoMark />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-display">{t('signIn.title')}</h1>
        <p className="text-body text-ink-muted">
          {t('signIn.link.as', { email: preview.data.email })}
        </p>
        {me.data !== undefined && me.data.user.email !== preview.data.email && (
          <p role="note" className="text-label text-warning-text">
            {t('signIn.link.replaces', { current: me.data.user.email })}
          </p>
        )}
      </div>
      {failed !== null && (
        <p role="alert" className="text-label text-danger-text">
          {`${t('signIn.link.failed')} ${describe(failed)}`}
        </p>
      )}
      <Button
        ref={action}
        variant="primary"
        busy={signingIn}
        className="w-full"
        onClick={() => {
          void signIn();
        }}
      >
        {t('signIn.link.submit')}
      </Button>
    </Card>
  );
};
