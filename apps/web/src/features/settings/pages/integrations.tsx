/**
 * The workspace's GitHub connection (D-23, `API.md` §7): an owner's or an admin's place to give the
 * workspace its one token, so a link to a pull request or an issue becomes a card (`PRD.md` §4.8).
 *
 * The token goes one way. The server seals it and never answers with it, so this says only whether
 * one is set and since when; a token typed here is sent, and the field is emptied once it is saved.
 * It is checked here against the contract's rule — printable, no spaces — so the common slip is
 * answered before a round trip; the server stays the authority, and its refusal lands in the field.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useToast } from '../../../ui/toast';
import { useWorkspace } from '../../shell/workspace';
import { SaveOutcome, SettingsCard, SettingsPage, SettingsRow, SettingsTextRow } from '../page';

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

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const wanted = token.trim();
    if (!TOKEN.test(wanted)) {
      setProblem({ field: 'token', message: t('github.invalid') });
      return;
    }
    setBusy('save');
    setProblem(null);
    try {
      await api.setGitHubToken(workspace.id, wanted);
      setToken('');
      show({ message: t('github.saved') });
      await reread();
    } catch (failure) {
      setProblem(
        isApiError(failure) && failure.code === 'VALIDATION_FAILED'
          ? { field: 'token', message: t('github.invalid') }
          : { field: 'form', message: `${t('github.saveFailed')} ${describe(failure)}` },
      );
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy('disconnect');
    setProblem(null);
    try {
      await api.removeGitHubToken(workspace.id);
      await reread();
    } catch (failure) {
      setProblem({
        field: 'form',
        message: `${t('github.disconnectFailed')} ${describe(failure)}`,
      });
    } finally {
      setBusy(null);
    }
  };

  const connected = status.data?.configured === true;
  return (
    <SettingsPage
      title={t('settings.integrations.title')}
      description={t('settings.integrations.description')}
    >
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
                disabled={token.trim() === ''}
              >
                {connected ? t('settings.integrations.replace') : t('github.save')}
              </Button>
            </>
          }
        >
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
            {status.isError ? (
              <span className="flex items-center gap-3">
                <span className="text-label text-ink-muted">{describe(status.error)}</span>
                <Button
                  onClick={() => {
                    void status.refetch();
                  }}
                >
                  {t('common.retry')}
                </Button>
              </span>
            ) : status.data === undefined ? (
              <LoadingStatus label={t('common.loading')} className="w-full">
                <Skeleton />
              </LoadingStatus>
            ) : (
              <span className="flex min-w-0 items-center gap-3">
                <span
                  className={
                    connected
                      ? 'inline-flex h-badge items-center rounded-pill bg-success-subtle px-2 text-caption font-medium text-success-text'
                      : 'inline-flex h-badge items-center rounded-pill bg-surface-200 px-2 text-caption font-medium text-ink-muted'
                  }
                >
                  {connected
                    ? t('settings.integrations.connected')
                    : t('settings.integrations.notConnected')}
                </span>
                {connected && (
                  <Button
                    variant="dangerQuiet"
                    busy={busy === 'disconnect'}
                    onClick={() => {
                      void disconnect();
                    }}
                  >
                    {t('github.disconnect')}
                  </Button>
                )}
              </span>
            )}
          </SettingsRow>
          <SettingsTextRow
            label={t('github.token')}
            hint={t('github.tokenHint')}
            type="password"
            placeholder={t('github.tokenShape')}
            value={token}
            maxLength={255}
            autoComplete="off"
            spellCheck={false}
            {...(problem?.field === 'token' ? { error: problem.message } : {})}
            onChange={(event) => {
              setToken(event.target.value);
            }}
          />
        </SettingsCard>
      </form>
    </SettingsPage>
  );
};
