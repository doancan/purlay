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
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { TextField } from '../../ui/text-field';
import { useToast } from '../../ui/toast';
import { useWorkspace } from '../shell/workspace';

/** `SetGitHubTokenRequest`'s rule: printable ASCII, no spaces. */
const TOKEN = /^[\x21-\x7e]+$/;

interface Problem {
  readonly field: 'token' | 'form';
  readonly message: string;
}

export const GitHubDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
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
    enabled: open,
  });
  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.githubIntegration(workspace.id) });
  };

  const change = (next: boolean): void => {
    // A token half typed is not kept once the dialog is closed.
    if (!next) {
      setToken('');
      setProblem(null);
    }
    onOpenChange(next);
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

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('github.title', { workspace: workspace.name })}
      description={t('github.description')}
      closeLabel={t('common.close')}
    >
      <section className="flex flex-col gap-2">
        {status.isError ? (
          <div className="flex items-center gap-3">
            <p className="text-body text-ink-muted">{describe(status.error)}</p>
            <Button
              onClick={() => {
                void status.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : status.data === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
            <Skeleton />
          </LoadingStatus>
        ) : (
          <div className="flex items-center gap-3">
            <p className="min-w-0 flex-1 text-body text-ink">
              {status.data.configured && status.data.updatedAt !== null
                ? t('github.connected', { when: format.absolute(status.data.updatedAt) })
                : t('github.notConnected')}
            </p>
            {status.data.configured && (
              <Button
                busy={busy === 'disconnect'}
                onClick={() => {
                  void disconnect();
                }}
              >
                {t('github.disconnect')}
              </Button>
            )}
          </div>
        )}
      </section>
      <form
        id={formId}
        onSubmit={(event) => {
          void save(event);
        }}
        className="flex flex-col gap-3"
      >
        <TextField
          label={t('github.token')}
          hint={t('github.tokenHint')}
          type="password"
          value={token}
          maxLength={255}
          required
          autoComplete="off"
          spellCheck={false}
          {...(problem?.field === 'token' ? { error: problem.message } : {})}
          onChange={(event) => {
            setToken(event.target.value);
          }}
        />
        <div>
          <Button type="submit" variant="primary" busy={busy === 'save'}>
            {t('github.save')}
          </Button>
        </div>
        {problem?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
      </form>
    </Dialog>
  );
};
