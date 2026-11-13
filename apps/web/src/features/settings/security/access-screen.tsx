/** A blocked member reaches only own security metadata: this route never mounts the chat shell. */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workspaceAccessRequiredKey } from '../../../data/access-change';
import { Value } from '@sinclair/typebox/value';
import { WorkspaceSecurityLookupQuery } from '@purlay/types/workspace-security';
import { useApi } from '../../../data/api-provider';
import { useI18n } from '../../../i18n/i18n-provider';
import { workspaceAccessHref, href } from '../../../router/routes';
import { useRoute } from '../../../router/router-provider';
import { Main } from '../../../ui/main';
import { Button, buttonStyle } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { LogoMark } from '../../shell/notice';
import { useSession } from '../../session/session';
import { CompanySignIn } from '../../sign-in/company-sign-in';
import { SettingsCard } from '../page';
import { WorkspaceMfa } from './mfa';
import { OwnerRecovery } from './recovery';
import { SecurityLoading } from './parts';

export const WorkspaceAccessScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  const { search, navigate } = useRoute();
  const { user, companyWorkspaceId } = useSession();
  const api = useApi();
  const client = useQueryClient();
  const workspace = new URLSearchParams(search).get('workspace') ?? '';
  const valid = Value.Check(WorkspaceSecurityLookupQuery, { workspace });
  const [typed, setTyped] = useState(workspace);
  const [invalid, setInvalid] = useState(false);
  const entry = useQuery({
    queryKey: ['workspace-security', user.id, 'entry', workspace],
    queryFn: async ({ signal }) => await api.workspaceSecurityEntry(workspace, signal),
    enabled: valid,
    staleTime: 0,
    gcTime: 0,
  });
  const reload = async (): Promise<void> => {
    await entry.refetch();
  };
  const security = entry.data;
  return (
    <Main className="flex min-h-screen flex-col items-center bg-surface-000 px-4 py-10 text-ink max-narrow:py-6">
      <div className="flex w-full max-w-settings flex-col gap-6">
        <header className="flex flex-col items-start gap-4">
          <LogoMark />
          <div className="flex flex-col gap-2">
            <h1 className="text-display text-ink">{t('security.access.title')}</h1>
            <p className="text-body text-ink-muted">{t('security.access.description')}</p>
            {security !== undefined && <p className="text-heading text-ink">{security.name}</p>}
          </div>
        </header>
        {!valid ? (
          <SettingsCard>
            <form
              noValidate
              className="flex flex-col gap-4 p-6 max-narrow:p-4"
              onSubmit={(event) => {
                event.preventDefault();
                const value = typed.trim().toLowerCase();
                if (!Value.Check(WorkspaceSecurityLookupQuery, { workspace: value })) {
                  setInvalid(true);
                  return;
                }
                navigate(workspaceAccessHref(value), { replace: true });
              }}
            >
              <TextField
                label={t('security.access.workspace')}
                value={typed}
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                {...(invalid ? { error: t('security.access.invalid') } : {})}
                onChange={(event) => {
                  setTyped(event.currentTarget.value);
                  setInvalid(false);
                }}
              />
              <Button variant="primary" type="submit">
                {t('security.access.find')}
              </Button>
            </form>
          </SettingsCard>
        ) : security === undefined || entry.isFetching ? (
          <SettingsCard>
            <SecurityLoading
              failed={entry.isError}
              retry={() => {
                void reload();
              }}
            />
          </SettingsCard>
        ) : (
          <div key={`${user.id}:${security.workspaceId}`} className="flex flex-col gap-6">
            <SettingsCard title={t(`security.status.${security.status.state}`)}>
              <div className="flex flex-col gap-4 px-6 py-5 max-narrow:px-4">
                {entry.isError && (
                  <SecurityLoading
                    failed
                    retry={() => {
                      void reload();
                    }}
                  />
                )}
                {security.status.state === 'allowed' ? (
                  <>
                    <p className="text-body text-ink-muted">{t('security.access.allowed')}</p>
                    <div>
                      <a
                        className={buttonStyle('primary')}
                        href={href('workspace', { slug: security.slug })}
                        onClick={() => {
                          client.removeQueries({
                            queryKey: workspaceAccessRequiredKey(security.workspaceId, user.id),
                            exact: true,
                          });
                        }}
                      >
                        {t('security.access.return')}
                      </a>
                    </div>
                  </>
                ) : security.status.state === 'sign_in_required' ? (
                  <>
                    <p className="text-body text-ink-muted">{t('security.access.company')}</p>
                    <CompanySignIn initialWorkspace={security.slug} />
                  </>
                ) : security.status.state === 'expired' ? (
                  <>
                    <p className="text-body text-ink-muted">{t('security.access.expired')}</p>
                    <div>
                      <a
                        className={buttonStyle('primary')}
                        href={`${href('signIn')}?workspace=${encodeURIComponent(security.slug)}&independent=1`}
                      >
                        {t('security.signIn')}
                      </a>
                    </div>
                  </>
                ) : (
                  <p className="text-body text-ink-muted">{t('security.code.fresh')}</p>
                )}
                <div>
                  <Button
                    onClick={() => {
                      void reload();
                    }}
                  >
                    {t('security.refresh')}
                  </Button>
                </div>
              </div>
            </SettingsCard>
            {(security.status.state === 'mfa_required' ||
              security.status.state === 'mfa_enrollment_required') && (
              <WorkspaceMfa
                workspaceId={security.workspaceId}
                companySession={companyWorkspaceId !== undefined}
                onVerified={reload}
              />
            )}
            {security.role === 'owner' && (
              <OwnerRecovery
                workspaceId={security.workspaceId}
                slug={security.slug}
                revision={security.status.policyRevision}
                companySession={companyWorkspaceId !== undefined}
                onRecovered={reload}
                onCreated={reload}
              />
            )}
          </div>
        )}
        <a href={href('home')} className="text-label text-accent-text underline">
          {t('security.access.other')}
        </a>
      </div>
    </Main>
  );
};
