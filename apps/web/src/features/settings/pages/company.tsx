/** Workspace-owned company setup, using the incumbent settings layout and native OAuth. */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPANY_CONNECTIONS_MAX,
  type CompanyIdentityConnection,
  type CompanyIdentityDomain,
} from '@purlay/types/workspace-identity';
import { useApi } from '../../../data/api-provider';
import { useAuthMethods } from '../../../data/queries';
import { keys } from '../../../data/keys';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { href } from '../../../router/routes';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { useToast } from '../../../ui/toast';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { leave } from '../../sign-in/leave';
import { SettingsCard, SettingsPage } from '../page';
import { CompanyDomains } from './company-domains';
import { CompanyConnectionEditor } from './company-connection-editor';
import {
  CompanyCopyValue,
  CompanyLoading,
  CompanySessionNotice,
  useCompanyAlive,
  type CompanyTask,
} from './company-parts';

export const CompanyPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const methods = useAuthMethods();
  const { user, companyWorkspaceId } = useSession();
  const { workspace } = useWorkspace();
  return (
    <SettingsPage title={t('company.title')} description={t('company.description')}>
      {methods.isError || methods.data === undefined ? (
        <SettingsCard>
          <CompanyLoading
            failed={methods.isError}
            retry={() => {
              void methods.refetch();
            }}
          />
        </SettingsCard>
      ) : methods.data.company === undefined ? (
        <SettingsCard>
          <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
            {t('company.unavailable')}
          </p>
        </SettingsCard>
      ) : (
        <CompanyManagement
          key={`${user.id}:${workspace.id}:${companyWorkspaceId ?? 'account'}`}
          callbackUrl={methods.data.company.callbackUrl}
        />
      )}
    </SettingsPage>
  );
};

const CompanyManagement = ({
  callbackUrl,
}: {
  readonly callbackUrl: string;
}): React.JSX.Element => {
  const api = useApi();
  const client = useQueryClient();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const { user, companyWorkspaceId } = useSession();
  const alive = useCompanyAlive();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ readonly task: string; readonly text: string } | null>(
    null,
  );
  const [editing, setEditing] = useState<CompanyIdentityConnection | 'new' | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && editing === null) opener.current?.focus();
    wasEditing.current = editing !== null;
  }, [editing]);
  const [removing, setRemoving] = useState<
    | { readonly kind: 'domain'; readonly value: CompanyIdentityDomain }
    | { readonly kind: 'connection'; readonly value: CompanyIdentityConnection }
    | null
  >(null);
  const domainsKey = keys.companyDomains(workspace.id, user.id);
  const connectionsKey = keys.companyConnections(workspace.id, user.id);
  const domains = useQuery({
    queryKey: domainsKey,
    queryFn: async ({ signal }) => await api.companyDomains(workspace.id, signal),
  });
  const connections = useQuery({
    queryKey: connectionsKey,
    queryFn: async ({ signal }) => await api.companyConnections(workspace.id, signal),
  });
  const refresh = async (): Promise<void> => {
    await Promise.all([
      client.invalidateQueries({ queryKey: domainsKey }),
      client.invalidateQueries({ queryKey: connectionsKey }),
      client.invalidateQueries({ queryKey: keys.myCompanyIdentities(workspace.id, user.id) }),
    ]);
  };
  const run: CompanyTask = async (name, work): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(name);
    setProblem(null);
    try {
      await work();
      if (!alive.current) return false;
      if (!name.startsWith('test:')) show({ message: t('company.saved') });
      return true;
    } catch (failure) {
      if (alive.current) setProblem({ task: name, text: describe(failure) });
      return false;
    } finally {
      if (alive.current) {
        await refresh();
        setBusy(null);
      }
      inFlight.current = false;
    }
  };
  const confirmRemoval = async (): Promise<void> => {
    if (removing === null) return;
    const current = removing;
    if (
      await run(`remove:${current.value.id}`, async () => {
        if (current.kind === 'domain')
          await api.revokeCompanyDomain(workspace.id, current.value.id, current.value.revision);
        else
          await api.deleteCompanyConnection(workspace.id, current.value.id, current.value.revision);
      })
    )
      setRemoving(null);
  };
  const entries = connections.data?.data ?? [];
  const verified = domains.data?.data.filter((domain) => domain.state === 'verified') ?? [];
  const signInAddress = new URL(href('signIn'), callbackUrl);
  signInAddress.searchParams.set('workspace', workspace.slug);
  const editingCurrent =
    editing === null || editing === 'new'
      ? undefined
      : entries.find((entry) => entry.id === editing.id);
  return (
    <>
      <CompanySessionNotice />
      {problem !== null &&
        problem.task !== 'connection:save' &&
        !problem.task.startsWith('remove:') && (
          <p role="alert" className="text-body text-danger-text">
            {problem.text}
          </p>
        )}
      <CompanyDomains
        workspaceId={workspace.id}
        query={domains}
        busy={busy}
        run={run}
        remove={(domain) => {
          setProblem(null);
          setRemoving({ kind: 'domain', value: domain });
        }}
      />
      <SettingsCard
        title={t('company.connections.title')}
        description={t('company.connections.description')}
        actions={
          <Button
            disabled={
              busy !== null ||
              editing !== null ||
              verified.length === 0 ||
              entries.length >= COMPANY_CONNECTIONS_MAX ||
              connections.data === undefined ||
              connections.isError ||
              domains.isError
            }
            onClick={(event) => {
              opener.current = event.currentTarget;
              setProblem(null);
              setEditing('new');
            }}
          >
            {t('company.connection.add')}
          </Button>
        }
      >
        {connections.isError || connections.data === undefined ? (
          <CompanyLoading
            failed={connections.isError}
            retry={() => {
              void connections.refetch();
            }}
          />
        ) : entries.length === 0 ? (
          <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
            {t('company.connections.empty')}
          </p>
        ) : (
          <ul className="flex flex-col">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-col gap-3 not-first:border-t-hairline border-border-subtle px-6 py-5 max-narrow:px-4"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <h3 className="text-label text-ink">{entry.name}</h3>
                  <p className="break-all text-caption text-ink-muted">{entry.issuer}</p>
                  <p className="text-label text-ink">
                    {t(
                      entry.enabled
                        ? 'company.connection.enabled'
                        : entry.ready
                          ? 'company.connection.ready'
                          : 'company.connection.needsTest',
                    )}
                  </p>
                </div>
                <div className="flex flex-wrap gap-3">
                  <Button
                    disabled={busy !== null}
                    onClick={(event) => {
                      opener.current = event.currentTarget;
                      setProblem(null);
                      setEditing(entry);
                    }}
                  >
                    {t('company.connection.edit')}
                  </Button>
                  <Button
                    disabled={busy !== null || companyWorkspaceId !== undefined}
                    busy={busy === `test:${entry.id}`}
                    onClick={() => {
                      void run(`test:${entry.id}`, async () => {
                        const started = await api.startCompanyIdentity({
                          workspaceId: workspace.id,
                          connectionId: entry.id,
                          revision: entry.revision,
                          intent: 'test',
                        });
                        if (alive.current) leave.to(started.url);
                      });
                    }}
                  >
                    {t('company.connection.test')}
                  </Button>
                  <Button
                    variant={entry.enabled ? 'secondary' : 'primary'}
                    disabled={busy !== null || (!entry.enabled && !entry.ready)}
                    onClick={() => {
                      void run(
                        `enabled:${entry.id}`,
                        async () =>
                          await api.setCompanyConnectionEnabled(
                            workspace.id,
                            entry.id,
                            entry.revision,
                            !entry.enabled,
                          ),
                      );
                    }}
                  >
                    {t(entry.enabled ? 'company.connection.disable' : 'company.connection.enable')}
                  </Button>
                  <Button
                    variant="dangerQuiet"
                    disabled={busy !== null}
                    onClick={() => {
                      setRemoving({ kind: 'connection', value: entry });
                    }}
                  >
                    {t('company.connection.remove')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-col gap-3 border-t-hairline border-border-subtle px-6 py-5 max-narrow:px-4">
          <p className="text-caption text-ink-muted">{t('company.connection.callbackHint')}</p>
          <CompanyCopyValue label={t('company.connection.callback')} value={callbackUrl} />
        </div>
      </SettingsCard>
      {editing !== null && (
        <CompanyConnectionEditor
          key={editing === 'new' ? 'new' : `${editing.id}:${editing.revision}`}
          initial={editing === 'new' ? null : editing}
          current={editingCurrent}
          domains={domains.isError ? [] : (domains.data?.data ?? [])}
          busy={busy !== null}
          problem={problem?.task === 'connection:save' ? problem.text : null}
          cancel={() => {
            setEditing(null);
          }}
          reload={(entry) => {
            setProblem(null);
            setEditing(entry);
          }}
          save={async (input) => {
            if ('revision' in input && editing === 'new') return false;
            const saved = await run('connection:save', async () =>
              'revision' in input
                ? await api.updateCompanyConnection(
                    workspace.id,
                    editing === 'new' ? '' : editing.id,
                    input,
                  )
                : await api.createCompanyConnection(workspace.id, input),
            );
            if (saved) setEditing(null);
            return saved;
          }}
        />
      )}
      <SettingsCard title={t('company.entry.title')} description={t('company.entry.description')}>
        <div className="flex flex-col gap-3 px-6 py-5 max-narrow:px-4">
          <CompanyCopyValue label={t('company.entry.title')} value={signInAddress.toString()} />
          <Button
            disabled={busy !== null}
            onClick={() => {
              void refresh();
            }}
          >
            {t('company.refresh')}
          </Button>
        </div>
      </SettingsCard>
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && busy === null) setRemoving(null);
        }}
        title={t('company.remove.title', {
          name:
            removing === null
              ? ''
              : removing.kind === 'domain'
                ? removing.value.domain
                : removing.value.name,
        })}
        description={t('company.remove.description')}
        closeLabel={t('common.cancel')}
        footer={
          <>
            <Button
              disabled={busy !== null}
              onClick={() => {
                setRemoving(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={removing !== null && busy === `remove:${removing.value.id}`}
              disabled={busy !== null}
              onClick={() => {
                void confirmRemoval();
              }}
            >
              {t('company.remove.confirm')}
            </Button>
          </>
        }
      >
        {removing !== null && problem?.task === `remove:${removing.value.id}` && (
          <p role="alert" className="text-label text-danger-text">
            {problem.text}
          </p>
        )}
      </Dialog>
    </>
  );
};
