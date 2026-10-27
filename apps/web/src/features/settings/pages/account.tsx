/**
 * Sessions & account (D-146): how the person signs in, leaving, and ending the account.
 *
 * *How you sign in* (D-176, D-179 §5) names the address and the GitHub account linked to it, and only
 * names them: GitHub is linked by signing in with it on an address that is verified, so there is
 * nothing here to press.
 *
 * *Sign out everywhere* ends every session the person holds, this one with them (D-11); it asks first,
 * because it signs out devices that are not in front of them. *Erase my account* is the dialog it has
 * always been (D-139 §5) — typing the username is the confirmation — opened from a card drawn in the
 * danger tone, so what cannot be undone looks it and sits apart from what can. *Leave <workspace>*
 * (D-152) sits there too: it asks first, and the last owner is told to hand the workspace on.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '../../../components/icon';
import { useMySignIn } from '../../../data/queries';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { href } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { useWorkspace } from '../../shell/workspace';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { EraseAccountDialog } from '../../shell/erase-account-dialog';
import { useSignOut } from '../../shell/sign-out';
import { SettingsCard, SettingsPage, SettingsRow } from '../page';
import { ChangePasswordCard } from './change-password-card';

const SignInCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const signIn = useMySignIn();

  return (
    <SettingsCard title={t('settings.account.signIn')}>
      {signIn.isError ? (
        <SettingsRow label={t('settings.account.signIn')}>
          <span className="flex items-center gap-3">
            <span className="text-label text-ink-muted">{describe(signIn.error)}</span>
            <Button
              onClick={() => {
                void signIn.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </span>
        </SettingsRow>
      ) : signIn.data === undefined ? (
        <SettingsRow label={t('settings.account.signIn')}>
          <LoadingStatus label={t('common.loading')} className="w-full">
            <Skeleton />
          </LoadingStatus>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow
            label={t('settings.account.email')}
            description={
              signIn.data.emailLinks
                ? t('settings.account.emailLinks')
                : t('settings.account.emailGitHub')
            }
          >
            <span className="min-w-0 truncate text-label text-ink">{signIn.data.email}</span>
          </SettingsRow>
          {signIn.data.oidc && (
            <SettingsRow
              label={t('settings.account.oidc')}
              description={t('settings.account.oidcSignsIn')}
            >
              <span className="flex min-w-0 items-center gap-2 text-label text-ink">
                <Icon name="lock" />
                <span className="truncate">{t('settings.account.oidcLinked')}</span>
              </span>
            </SettingsRow>
          )}
          {signIn.data.github !== null && (
            <SettingsRow
              label={t('settings.account.github')}
              description={t('settings.account.githubSignsIn')}
            >
              <span className="flex min-w-0 items-center gap-2 text-label text-ink">
                <Icon name="github" />
                <span className="truncate">
                  {signIn.data.github.login ?? t('settings.account.githubLinked')}
                </span>
              </span>
            </SettingsRow>
          )}
        </>
      )}
    </SettingsCard>
  );
};

/** Only an account that has a password has one to change; the card is not drawn for the others. */
const PasswordSection = (): React.JSX.Element | null => {
  const signIn = useMySignIn();
  return signIn.data?.hasPassword === true ? (
    <ChangePasswordCard email={signIn.data.email} />
  ) : null;
};

export const AccountPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const leave = useSignOut();
  const [confirming, setConfirming] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [leavingAsk, setLeavingAsk] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [leaveProblem, setLeaveProblem] = useState<string | null>(null);
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();

  const leaveWorkspace = async (): Promise<void> => {
    setLeaving(true);
    setLeaveProblem(null);
    try {
      await api.leaveWorkspace(workspace.id);
    } catch (failure) {
      setLeaving(false);
      setLeaveProblem(
        isApiError(failure) && failure.code === 'LAST_OWNER'
          ? t('settings.account.leaveLastOwner')
          : `${t('settings.account.leaveFailed')} ${describe(failure)}`,
      );
      return;
    }
    // Out: the memberships are read again, and the front door takes them to what is left.
    setLeavingAsk(false);
    await client.invalidateQueries({ queryKey: keys.me });
    navigate(href('home'), { replace: true });
  };
  return (
    <SettingsPage
      title={t('settings.account.title')}
      description={t('settings.account.description')}
    >
      <SignInCard />
      <PasswordSection />
      <SettingsCard title={t('settings.account.sessions')}>
        <SettingsRow
          label={t('settings.account.here')}
          description={t('settings.account.hereHint')}
        >
          <Button
            glyph="sign-out"
            onClick={() => {
              leave('here');
            }}
          >
            {t('user.signOut')}
          </Button>
        </SettingsRow>
        <SettingsRow
          label={t('user.signOutEverywhere')}
          description={t('user.signOutEverywhere.body')}
        >
          <Button
            glyph="sign-out"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('user.signOutEverywhere.entry')}
          </Button>
        </SettingsRow>
      </SettingsCard>
      <SettingsCard title={t('settings.account.danger')} tone="danger">
        <SettingsRow
          label={t('settings.account.leave', { workspace: workspace.name })}
          description={leaveProblem ?? t('settings.account.leaveHint')}
        >
          <Button
            variant="dangerQuiet"
            // Under the words on a phone, a fill-less button's words line up with them, not its edge.
            className="max-narrow:-ml-3"
            glyph="sign-out"
            onClick={() => {
              setLeaveProblem(null);
              setLeavingAsk(true);
            }}
          >
            {t('settings.account.leaveEntry')}
          </Button>
        </SettingsRow>
        <SettingsRow label={t('erase.title')} description={t('settings.account.eraseHint')}>
          <Button
            variant="dangerQuiet"
            className="max-narrow:-ml-3"
            glyph="delete"
            onClick={() => {
              setErasing(true);
            }}
          >
            {t('erase.entry')}
          </Button>
        </SettingsRow>
      </SettingsCard>
      <Dialog
        open={leavingAsk}
        onOpenChange={(next) => {
          if (!leaving) setLeavingAsk(next);
        }}
        title={t('settings.account.leaveTitle', { workspace: workspace.name })}
        description={t('settings.account.leaveHint')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={leaving}
              onClick={() => {
                setLeavingAsk(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              glyph="sign-out"
              busy={leaving}
              onClick={() => {
                void leaveWorkspace();
              }}
            >
              {t('settings.account.leaveConfirm', { workspace: workspace.name })}
            </Button>
          </>
        }
      >
        {leaveProblem !== null && (
          <p role="alert" className="text-label text-danger-text">
            {leaveProblem}
          </p>
        )}
      </Dialog>
      <EraseAccountDialog
        open={erasing}
        onOpenChange={setErasing}
        onSignOut={() => {
          leave('here');
        }}
      />
      <Dialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('user.signOutEverywhere.title')}
        description={t('user.signOutEverywhere.body')}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              glyph="sign-out"
              onClick={() => {
                setConfirming(false);
                leave('everywhere');
              }}
            >
              {t('user.signOutEverywhere')}
            </Button>
          </>
        }
      >
        {null}
      </Dialog>
    </SettingsPage>
  );
};
