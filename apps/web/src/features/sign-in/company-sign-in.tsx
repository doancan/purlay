/** Exact workspace lookup, followed by a real native provider round trip; no employee directory. */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { WORKSPACE_SLUG_MAX } from '@purlay/types';
import { CompanySignInQuery } from '@purlay/types/workspace-identity';
import { useApi } from '../../data/api-provider';
import { keys } from '../../data/keys';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { TextField } from '../../ui/text-field';
import { Button } from '../../ui/button';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { leave } from './leave';

export const CompanySignIn = ({
  initialWorkspace,
}: {
  readonly initialWorkspace: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const alive = useRef(true);
  const selection = useRef<string | null>(null);
  const starting = useRef(false);
  const [typed, setTyped] = useState(initialWorkspace);
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalidWorkspace, setInvalidWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  const options = useQuery({
    queryKey: keys.companySignInOptions(workspace ?? ''),
    queryFn: async ({ signal }) => await api.companySignInOptions(workspace ?? '', signal),
    enabled: workspace !== null,
  });
  const submit = (event: React.SyntheticEvent): void => {
    event.preventDefault();
    const wanted = typed.trim().toLowerCase();
    if (!Value.Check(CompanySignInQuery, { workspace: wanted })) {
      setInvalidWorkspace(t('company.signIn.invalid'));
      return;
    }
    selection.current = wanted;
    setWorkspace(wanted);
    setTyped(wanted);
    setProblem(null);
    setInvalidWorkspace(null);
  };
  const signIn = async (connectionId: string): Promise<void> => {
    if (workspace === null || selection.current !== workspace || starting.current) return;
    starting.current = true;
    setBusy(connectionId);
    setProblem(null);
    const requested = workspace;
    try {
      const result = await api.signInWithCompany({ workspace, connectionId });
      if (alive.current && selection.current === requested) leave.to(result.url);
    } catch (failure) {
      if (alive.current && selection.current === requested) setProblem(describe(failure));
    } finally {
      starting.current = false;
      if (alive.current) setBusy(null);
    }
  };
  return (
    <div className="flex w-full flex-col gap-4 border-t-hairline border-border-subtle pt-6 text-left">
      <div className="flex flex-col gap-1">
        <h2 className="text-heading text-ink">{t('company.signIn.title')}</h2>
        <p className="text-caption text-ink-muted">{t('company.signIn.description')}</p>
      </div>
      <form noValidate className="flex flex-col gap-3" onSubmit={submit}>
        <TextField
          label={t('company.signIn.workspace')}
          value={typed}
          maxLength={WORKSPACE_SLUG_MAX}
          required
          autoComplete="organization"
          autoCapitalize="none"
          spellCheck={false}
          disabled={busy !== null}
          {...(invalidWorkspace === null ? {} : { error: invalidWorkspace })}
          onChange={(event) => {
            selection.current = null;
            setWorkspace(null);
            setTyped(event.currentTarget.value);
            setProblem(null);
            setInvalidWorkspace(null);
          }}
        />
        <Button type="submit" disabled={typed.trim() === '' || busy !== null}>
          {t('company.signIn.find')}
        </Button>
      </form>
      {problem !== null && (
        <p role="alert" className="text-caption text-danger-text">
          {problem}
        </p>
      )}
      {workspace !== null &&
        (options.isError ? (
          <div className="flex flex-col gap-2">
            <p role="alert" className="text-caption text-danger-text">
              {describe(options.error)}
            </p>
            <Button
              onClick={() => {
                void options.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : options.data === undefined ? (
          <LoadingStatus label={t('common.loading')}>
            <Skeleton />
          </LoadingStatus>
        ) : options.data.connections.length === 0 ? (
          <p role="status" className="text-caption text-ink-muted">
            {t('company.signIn.empty')}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {options.data.connections.map((connection) => (
              <Button
                key={connection.id}
                variant="primary"
                disabled={busy !== null}
                busy={busy === connection.id}
                onClick={() => {
                  void signIn(connection.id);
                }}
              >
                {t('company.signIn.with', { name: connection.name })}
              </Button>
            ))}
          </div>
        ))}
    </div>
  );
};
