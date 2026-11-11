/**
 * The workspace's GitHub connection (D-23, `API.md` §7): an owner's or an admin's place to give the
 * workspace its one token, so a link to a pull request or an issue becomes a card (`PRD.md` §4.8).
 *
 * The token goes one way. The server seals it and never answers with it, so this says only whether
 * one is set and since when; a token typed here is sent, and the field is emptied once it is saved.
 * It is checked here against the contract's rule — printable, no spaces — so the common slip is
 * answered before a round trip; the server stays the authority, and its refusal lands in the field.
 * The server also asks GitHub whether it accepts the token before keeping it, and says afterwards when
 * GitHub stopped accepting one (revoked, expired) and when a classic token is broader than cards need
 * (D-23, amended; #884): both are shown here, to whoever can configure it.
 */
import { GITHUB_TOKEN_MAX, type GitHubIntegration } from '@purlay/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError, isUnconfirmedMutation } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useToast } from '../../../ui/toast';
import { useWorkspace } from '../../shell/workspace';
import {
  SaveOutcome,
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsTextRow,
} from '../../settings/page';
import { GitHubInstallationCard } from '../../settings/pages/github-issues';
import { WorkspaceWebhooks } from '../channel/workspace-webhooks';

/** `SetGitHubTokenRequest`'s rule: printable ASCII, no spaces. */
const TOKEN = /^[\x21-\x7e]+$/;

interface Problem {
  readonly field: 'token' | 'form';
  readonly message: string;
}

export const IntegrationsPage = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const formId = useId();
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState<'save' | 'disconnect' | null>(null);

  const status = useQuery({
    queryKey: keys.githubIntegration(workspace.id),
    queryFn: async ({ signal }) => await api.githubIntegration(workspace.id, signal),
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.githubIntegration(workspace.id) });
  };
  const apply = async (receipt: GitHubIntegration): Promise<void> => {
    await client.cancelQueries({ queryKey: keys.githubIntegration(workspace.id), exact: true });
    client.setQueryData(keys.githubIntegration(workspace.id), receipt);
  };

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (busy !== null) return;
    const wanted = token.trim();
    if (!TOKEN.test(wanted)) {
      setProblem({ field: 'token', message: t('github.invalid') });
      return;
    }
    setBusy('save');
    setProblem(null);
    try {
      const receipt = await api.setGitHubToken(workspace.id, wanted);
      await apply(receipt);
      setToken('');
      show({ message: t('github.saved') });
      await reread();
    } catch (failure) {
      setProblem(
        isUnconfirmedMutation(failure)
          ? { field: 'form', message: t('github.unconfirmed') }
          : isApiError(failure) && failure.code === 'VALIDATION_FAILED'
            ? { field: 'token', message: t('github.rejected') }
            : isApiError(failure) && failure.code === 'GITHUB_UNAVAILABLE'
              ? { field: 'form', message: `${t('github.saveFailed')} ${t('github.unreachable')}` }
              : { field: 'form', message: `${t('github.saveFailed')} ${describe(failure)}` },
      );
      void reread();
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (busy !== null) return;
    setBusy('disconnect');
    setProblem(null);
    try {
      const receipt = await api.removeGitHubToken(workspace.id);
      await apply(receipt);
      show({ message: t('github.disconnected') });
      await reread();
    } catch (failure) {
      setProblem({
        field: 'form',
        message: isUnconfirmedMutation(failure)
          ? t('github.unconfirmed')
          : `${t('github.disconnectFailed')} ${describe(failure)}`,
      });
      void reread();
    } finally {
      setBusy(null);
    }
  };

  const connected = status.data?.configured === true;
  const refused = status.data?.invalidSince ?? null;
  return (
    <SettingsPage
      title={t('settings.integrations.title')}
      description={t('settings.integrations.description')}
    >
      <WorkspaceWebhooks key={workspace.id} />
      <form
        id={formId}
        onSubmit={(event) => {
          void save(event);
        }}
      >
        <SettingsCard
          title={t('settings.integrations.github')}
          description={t('github.description')}
          footer={
            <>
              <SaveOutcome
                outcome={problem?.field === 'form' ? { ok: false, words: problem.message } : null}
              />
              <Button
                type="submit"
                variant="primary"
                busy={busy === 'save'}
                disabled={token.trim() === '' || busy !== null}
              >
                {connected ? t('settings.integrations.replace') : t('github.save')}
              </Button>
            </>
          }
        >
          {refused !== null && (
            <p role="alert" className="text-label text-danger-text">
              {t('github.revoked', { when: format.absolute(refused) })}
            </p>
          )}
          {status.data?.broadScopes === true && (
            <p role="status" className="text-label text-warning-text">
              {t('github.broad')}
            </p>
          )}
          <SettingsRow
            label={t('settings.integrations.status')}
            {...(status.data === undefined
              ? {}
              : {
                  description:
                    connected && status.data.updatedAt !== null
                      ? t('github.connected', { when: format.absolute(status.data.updatedAt) })
                      : t('github.notConnected'),
                })}
          >
            <span className="flex min-w-0 flex-col gap-3">
              {status.isError && (
                <span className="flex flex-wrap items-center gap-3">
                  <span role="alert" className="text-label text-ink-muted">
                    {status.data !== undefined && t('github.refreshFailed')}{' '}
                    {describe(status.error)}
                  </span>
                  <Button
                    busy={status.isFetching}
                    onClick={() => {
                      void status.refetch();
                    }}
                  >
                    {t('common.retry')}
                  </Button>
                </span>
              )}
              {status.data === undefined ? (
                !status.isError && (
                  <LoadingStatus label={t('common.loading')} className="w-full">
                    <Skeleton />
                  </LoadingStatus>
                )
              ) : (
                <span className="flex min-w-0 items-center gap-3">
                  <span
                    className={
                      refused !== null
                        ? 'inline-flex h-badge items-center rounded-pill bg-danger-subtle px-2 text-caption font-medium text-danger-text'
                        : connected
                          ? 'inline-flex h-badge items-center rounded-pill bg-success-subtle px-2 text-caption font-medium text-success-text'
                          : 'inline-flex h-badge items-center rounded-pill bg-surface-200 px-2 text-caption font-medium text-ink-muted'
                    }
                  >
                    {refused !== null
                      ? t('settings.integrations.refused')
                      : connected
                        ? t('settings.integrations.connected')
                        : t('settings.integrations.notConnected')}
                  </span>
                  {connected && (
                    <Button
                      variant="dangerQuiet"
                      busy={busy === 'disconnect'}
                      disabled={busy !== null}
                      onClick={() => {
                        void disconnect();
                      }}
                    >
                      {t('github.disconnect')}
                    </Button>
                  )}
                </span>
              )}
            </span>
          </SettingsRow>
          <SettingsTextRow
            readOnly={busy !== null}
            label={t('github.token')}
            hint={t('github.tokenHint')}
            type="password"
            placeholder={t('github.tokenShape')}
            value={token}
            maxLength={GITHUB_TOKEN_MAX}
            autoComplete="off"
            spellCheck={false}
            {...(problem?.field === 'token' ? { error: problem.message } : {})}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
        </SettingsCard>
      </form>
      <GitHubInstallationCard />
    </SettingsPage>
  );
};
