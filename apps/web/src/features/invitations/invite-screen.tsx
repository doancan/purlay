/**
 * `/invite` — an invitation opened (D-115, `UX.md` §2): which workspace, until when, and **Join**; or
 * **Open** for somebody already in it. On the sign-in card's shape, because for a newcomer it is the
 * screen after sign-in.
 *
 * **Signed out** the page is a way in, not a bounce to sign-in: before the person leaves for GitHub, or
 * asks for a link, it asks the server for the invitation's passport (`POST /api/invitations/passport`,
 * R51) — the answer sets the cookie GitHub's callback will present, or records the address a link may
 * make an account for — and only when it is given does anything else happen. Whatever the server
 * refuses is said here in words and nothing else is done. A person who already has an account is
 * pointed to sign-in; the invitation stays in the tab and the front door brings them back to it.
 *
 * The token was moved out of the address as the page loaded (`pending.ts`); this reads it from the
 * tab. A link that does not open — the server's one refusal for unknown, expired, revoked or a
 * deleted workspace — is said in one sentence with the way home, and forgotten. Any other failure
 * keeps the token and offers Retry, because the link may well open a moment later.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AppSkeleton } from '../../app/skeleton';
import { useActions } from '../../data/actions-provider';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useAuthMethods, useMe } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { Link, useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { SessionGate } from '../session/session';
import { LogoMark } from '../../ui/notice';
import { DoorCard, DoorNotice } from '../sign-in/door-card';
import { EmailSignInForm } from '../sign-in/email-sign-in-form';
import { GitHubButton } from '../sign-in/github-button';
import { GoogleButton } from '../sign-in/google-button';
import { OidcButton } from '../sign-in/oidc-button';
import { browserInvitationPorts, forgetInvitation, pendingInvitation } from './pending';
import { GuestInvitationSummary } from './guest-invitation-summary';

const doesNotOpen = (failure: unknown): boolean =>
  isApiError(failure) && failure.code === 'INVITATION_NOT_FOUND';

const JoinInvitation = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const { joinWorkspace } = useActions();
  const { navigate } = useRoute();
  const describe = useDescribeFailure();
  const ports = useMemo(browserInvitationPorts, []);
  const [token] = useState(() => pendingInvitation(ports, window.location));
  const [joining, setJoining] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);

  const preview = useQuery({
    queryKey: keys.invitation(token ?? ''),
    queryFn: async ({ signal }) => await api.previewInvitation(token ?? '', signal),
    enabled: token !== null,
    // A refusal is an answer, not a blip; anything else the person retries by hand.
    retry: false,
  });

  const home = (
    <Button
      variant="primary"
      onClick={() => {
        navigate(href('home'), { replace: true });
      }}
    >
      {t('invite.home')}
    </Button>
  );
  const goneFor = token === null || doesNotOpen(preview.error) || doesNotOpen(failed);
  if (goneFor) {
    forgetInvitation(ports);
    return (
      <DoorNotice
        glyph="warning"
        title={t('invite.gone.title')}
        body={t('invite.gone.body')}
        action={home}
      />
    );
  }

  if (preview.isError) {
    return (
      <DoorNotice
        glyph="failed"
        title={t('invite.failed.title')}
        body={describe(preview.error)}
        action={
          <Button
            onClick={() => {
              void preview.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  if (preview.data === undefined) {
    return (
      <DoorCard>
        <LoadingStatus
          label={t('invite.loading')}
          className="flex w-full flex-col items-center gap-3"
        >
          <Skeleton className="w-members" />
          <Skeleton />
        </LoadingStatus>
      </DoorCard>
    );
  }

  const { workspace, expiresAt, member, guest } = preview.data;
  const enter = (): void => {
    forgetInvitation(ports);
    navigate(href('workspace', { slug: workspace.slug }), { replace: true });
  };
  // Just joined: the channels to join come first (D-132); one already in goes straight in.
  const welcome = (): void => {
    forgetInvitation(ports);
    navigate(href('welcome', { slug: workspace.slug }), { replace: true });
  };
  const join = async (): Promise<void> => {
    setJoining(true);
    setFailed(null);
    try {
      const membership = await joinWorkspace(token);
      if (membership.access?.kind === 'guest') enter();
      else welcome();
    } catch (failure) {
      setJoining(false);
      setFailed(failure);
    }
  };

  return (
    <DoorCard>
      <LogoMark />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-balance text-display wrap-anywhere">
          {t('invite.title', { workspace: workspace.name })}
        </h1>
        <p className="text-balance text-body text-ink-muted">
          {member
            ? t('invite.member', { workspace: workspace.name })
            : t('invite.body', { until: format.absolute(expiresAt) })}
        </p>
        {guest !== undefined && <GuestInvitationSummary value={guest} history />}
      </div>
      {failed !== null && (
        <p role="alert" className="text-balance text-label text-danger-text">
          {`${t('invite.joinFailed')} ${describe(failed)}`}
        </p>
      )}
      {member ? (
        <Button variant="primary" className="w-full" onClick={enter}>
          {t('invite.open')}
        </Button>
      ) : (
        <Button
          variant="primary"
          busy={joining}
          className="w-full"
          onClick={() => {
            void join();
          }}
        >
          {t('invite.join')}
        </Button>
      )}
    </DoorCard>
  );
};

/** The card for a person who is not signed in: GitHub, or a link by email, each after the passport. */
const SignedOutInvitation = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { navigate } = useRoute();
  const describe = useDescribeFailure();
  const methods = useAuthMethods();
  const ports = useMemo(browserInvitationPorts, []);
  const [token] = useState(() => pendingInvitation(ports, window.location));
  const [gone, setGone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (token === null || gone) {
    forgetInvitation(ports);
    return (
      <DoorNotice
        glyph="warning"
        title={t('invite.gone.title')}
        body={t('invite.gone.body')}
        action={
          <Button
            variant="primary"
            onClick={() => {
              navigate(href('home'), { replace: true });
            }}
          >
            {t('invite.home')}
          </Button>
        }
      />
    );
  }

  /** The passport, then whether to go on: a refusal is said here, in words, and nothing else happens. */
  const askPassport = async (email?: string): Promise<boolean> => {
    setProblem(null);
    try {
      await api.openInvitationPassport({ token, ...(email === undefined ? {} : { email }) });
      return true;
    } catch (caught) {
      if (doesNotOpen(caught)) setGone(true);
      else if (isApiError(caught) && caught.code === 'RATE_LIMITED') {
        setProblem(t('invite.passport.tooMany'));
      } else if (isApiError(caught) && caught.code === 'VALIDATION_FAILED') {
        setProblem(t('signIn.email.invalid'));
      } else setProblem(`${t('invite.passport.failed')} ${describe(caught)}`);
      return false;
    }
  };

  const github = methods.data?.github === true;
  const google = methods.data?.google === true;
  const oidc = methods.data?.oidc ?? null;
  const mail = methods.data?.email === true;
  return (
    <DoorCard>
      <LogoMark />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-balance text-display">{t('invite.signedOut.title')}</h1>
        <p className="text-balance text-body text-ink-muted">{t('invite.signedOut.body')}</p>
      </div>
      {methods.data === undefined && !methods.isError ? (
        <LoadingStatus label={t('common.loading')} className="flex w-full flex-col gap-3">
          <Skeleton className="h-control w-full rounded-md max-narrow:h-touch" />
        </LoadingStatus>
      ) : (
        <>
          {/* The ways out to another page stand together, as on the sign-in card. */}
          {(oidc !== null || github || google || methods.isError) && (
            <div className="flex w-full flex-col gap-3">
              {oidc !== null && (
                <OidcButton
                  name={oidc.name}
                  variant={mail || github || google ? 'secondary' : 'primary'}
                  before={async () => await askPassport()}
                />
              )}
              {(github || methods.isError) && (
                <GitHubButton
                  variant={mail || google || oidc !== null ? 'secondary' : 'primary'}
                  before={async () => await askPassport()}
                />
              )}
              {google && (
                <GoogleButton
                  variant={mail || github || oidc !== null ? 'secondary' : 'primary'}
                  before={async () => await askPassport()}
                />
              )}
            </div>
          )}
          {mail && (
            <EmailSignInForm
              alone={!github && !google && oidc === null}
              mail
              beforeLink={async (email) => await askPassport(email)}
            />
          )}
        </>
      )}
      {problem !== null && (
        <p role="alert" className="text-balance text-label text-danger-text">
          {problem}
        </p>
      )}
      <p className="text-balance text-label text-ink-muted">
        {t('invite.signedOut.haveAccount')}{' '}
        <Link to="signIn" className="text-accent-text underline">
          {t('invite.signedOut.signIn')}
        </Link>
      </p>
    </DoorCard>
  );
};

export const InviteScreen = (): React.JSX.Element => {
  const me = useMe();
  const signedOut = me.isError && isApiError(me.error) && me.error.status === 401;
  if (me.isPending) return <AppSkeleton />;
  if (signedOut) return <SignedOutInvitation />;
  return (
    <SessionGate>
      <JoinInvitation />
    </SessionGate>
  );
};
