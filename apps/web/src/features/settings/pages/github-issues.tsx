/**
 * GitHub issues from conversations, connected (D-246 §1–2): an owner's installation of the server's GitHub App
 * on Integrations, and each person's own opt-in to let Purlay write as them on Sessions & account. Two cards,
 * two credentials: what everybody shares is read through the installation, and a person's token exists only if
 * they chose to give it here. Neither is drawn where the server has no App — then nothing of this exists.
 * Both leave for GitHub by a full navigation (`leave`) and are told how the trip went by `?github=`.
 */
import { GITHUB_CALLBACK_OUTCOMES, type GitHubAppStatus } from '@purlay/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { useRoute } from '../../../router/router-provider';
import { Button } from '../../../ui/button';
import { leave } from '../../sign-in/leave';
import { Note } from '../../setup/parts';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard, SettingsRow } from '../page';

/** The status, asked once for both cards; undefined until known, and while it failed. */
const useGitHubApp = (): {
  readonly status: GitHubAppStatus | undefined;
  readonly reread: () => Promise<void>;
  readonly workspaceId: string;
} => {
  const api = useApi();
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const status = useQuery({
    queryKey: keys.githubApp(workspace.id),
    queryFn: async ({ signal }) => await api.githubApp(workspace.id, signal),
  });
  return {
    status: status.data,
    workspaceId: workspace.id,
    reread: async (): Promise<void> => {
      await client.invalidateQueries({ queryKey: keys.githubApp(workspace.id) });
    },
  };
};

/** How the last trip to GitHub went, said once, from the address GitHub's return was sent on to. */
const Outcome = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { search } = useRoute();
  const said = new URLSearchParams(search).get('github');
  const outcome = GITHUB_CALLBACK_OUTCOMES.find((known) => known === said);
  if (outcome === undefined) return null;
  const good = outcome === 'connected' || outcome === 'authorized';
  return <Note tone={good ? 'good' : 'warn'}>{t(`githubIssues.outcome.${outcome}`)}</Note>;
};

const pill = (on: boolean): string =>
  on
    ? 'inline-flex h-badge items-center rounded-pill bg-success-subtle px-2 text-caption font-medium text-success-text'
    : 'inline-flex h-badge items-center rounded-pill bg-surface-200 px-2 text-caption font-medium text-ink-muted';

/** An owner's: the workspace's installation of the App, and the repositories it was given on GitHub. */
export const GitHubInstallationCard = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { status, reread, workspaceId } = useGitHubApp();
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [failure, setFailure] = useState('');
  if (status?.available !== true) return null;
  const installation = status.installation;

  const connect = async (): Promise<void> => {
    setBusy('connect');
    setFailure('');
    try {
      leave.to((await api.startGitHubInstallation(workspaceId)).url);
    } catch (caught) {
      setFailure(describe(caught));
      setBusy(null);
    }
  };
  const disconnect = async (): Promise<void> => {
    setBusy('disconnect');
    setFailure('');
    try {
      await api.removeGitHubInstallation(workspaceId);
      await reread();
    } catch (caught) {
      setFailure(describe(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsCard
      title={t('githubIssues.title')}
      description={t('githubIssues.description')}
      footer={
        <>
          {failure !== '' && (
            <p role="alert" className="min-w-0 flex-1 text-label text-danger-text">
              {failure}
            </p>
          )}
          {installation !== null && (
            <Button
              variant="dangerQuiet"
              busy={busy === 'disconnect'}
              disabled={busy !== null}
              onClick={() => {
                void disconnect();
              }}
            >
              {t('githubIssues.disconnect')}
            </Button>
          )}
          <Button
            variant="primary"
            busy={busy === 'connect'}
            disabled={busy !== null}
            onClick={() => {
              void connect();
            }}
          >
            {installation === null ? t('githubIssues.connect') : t('githubIssues.reconnect')}
          </Button>
        </>
      }
    >
      <SettingsRow
        label={t('settings.integrations.status')}
        description={
          installation === null
            ? t('githubIssues.notInstalled')
            : t('githubIssues.installed', {
                account: installation.accountLogin,
                when: format.absolute(installation.connectedAt),
              })
        }
      >
        <span className={pill(installation !== null && !installation.suspended)}>
          {installation === null
            ? t('settings.integrations.notConnected')
            : installation.suspended
              ? t('githubIssues.suspendedBadge')
              : t('settings.integrations.connected')}
        </span>
      </SettingsRow>
      {installation?.suspended === true && (
        <div className="px-6 pb-5 max-narrow:px-4">
          <Note tone="warn">{t('githubIssues.suspended')}</Note>
        </div>
      )}
      <div className="px-6 pb-5 max-narrow:px-4 empty:hidden">
        <Outcome />
      </div>
    </SettingsCard>
  );
};

/** Everybody's own: whether Purlay may write to GitHub as them. Off until they say so; never asked at sign-in. */
export const GitHubWriteCard = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { search, pathname } = useRoute();
  const { status, reread } = useGitHubApp();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  if (status?.available !== true) return null;
  const authorization = status.authorization;

  const allow = async (): Promise<void> => {
    setBusy(true);
    setFailure('');
    try {
      // Back to this page, without the last trip's word, so the new one is the only one said.
      const own = new URLSearchParams(search);
      own.delete('github');
      const tail = own.toString();
      leave.to(
        (await api.startGitHubAuthorization(tail === '' ? pathname : `${pathname}?${tail}`)).url,
      );
    } catch (caught) {
      setFailure(describe(caught));
      setBusy(false);
    }
  };
  const forget = async (): Promise<void> => {
    setBusy(true);
    setFailure('');
    try {
      await api.forgetGitHubAuthorization();
      await reread();
    } catch (caught) {
      setFailure(describe(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard title={t('githubIssues.me.title')} description={t('githubIssues.me.description')}>
      <SettingsRow
        label={t('githubIssues.me.label')}
        description={
          authorization === null
            ? t('githubIssues.me.off')
            : t('githubIssues.me.on', { login: authorization.login })
        }
      >
        <span className="flex items-center gap-3">
          <span className={pill(authorization !== null)}>
            {authorization === null ? t('githubIssues.me.badgeOff') : t('githubIssues.me.badgeOn')}
          </span>
          <Button
            variant={authorization === null ? 'primary' : 'dangerQuiet'}
            busy={busy}
            onClick={() => {
              void (authorization === null ? allow() : forget());
            }}
          >
            {authorization === null ? t('githubIssues.me.allow') : t('githubIssues.me.forget')}
          </Button>
        </span>
      </SettingsRow>
      {failure !== '' && (
        <p role="alert" className="px-6 pb-5 text-label text-danger-text max-narrow:px-4">
          {failure}
        </p>
      )}
      <div className="px-6 pb-5 max-narrow:px-4 empty:hidden">
        <Outcome />
      </div>
    </SettingsCard>
  );
};
