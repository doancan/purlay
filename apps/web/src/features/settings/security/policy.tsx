/** Revision-bound preview, actual authentication test, then explicit policy enforcement. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import {
  WorkspacePolicySettings,
  WORKSPACE_POLICY_CONNECTIONS_MAX,
  type WorkspaceAccessPolicy,
  type WorkspacePolicyPreview,
  type WorkspacePolicyTest,
} from '@purlay/types/workspace-security';
import type { CompanyIdentityConnection } from '@purlay/types/workspace-identity';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { isApiError } from '../../../data/errors';
import { useI18n } from '../../../i18n/i18n-provider';
import { href } from '../../../router/routes';
import { Button, buttonStyle } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { Select } from '../../../ui/select';
import { TextField } from '../../../ui/text-field';
import { SettingsCard, SettingsPage, SettingsRow } from '../page';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import { WorkspaceMfa } from './mfa';
import { OwnerRecovery } from './recovery';
import { SecurityLoading, SecurityProblem, useExpired, useSecurityTask } from './parts';

export const WorkspaceSecurityPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace, role } = useWorkspace();
  const { user, companyWorkspaceId } = useSession();
  const api = useApi();
  const [saved, setSaved] = useState(false);
  const policy = useQuery({
    queryKey: ['workspace-security', user.id, workspace.id, 'policy'],
    queryFn: async ({ signal }) => await api.workspacePolicy(workspace.id, signal),
  });
  return (
    <SettingsPage title={t('security.title')} description={t('security.description')}>
      {policy.data === undefined ? (
        <SettingsCard>
          <SecurityLoading
            failed={policy.isError}
            retry={() => {
              void policy.refetch();
            }}
          />
        </SettingsCard>
      ) : (
        <>
          <PolicyEditor
            key={`${user.id}:${workspace.id}:${policy.data.revision ?? 'off'}`}
            policy={policy.data}
            workspaceId={workspace.id}
            slug={workspace.slug}
            companySession={companyWorkspaceId !== undefined}
            mayEnforce={role === 'owner'}
            readFailed={policy.isError}
            saved={saved}
            setSaved={setSaved}
            refresh={async () => {
              await policy.refetch();
            }}
          />
          {role === 'owner' && (
            <OwnerRecovery
              key={`${user.id}:${workspace.id}`}
              workspaceId={workspace.id}
              slug={workspace.slug}
              revision={policy.data.revision}
              companySession={companyWorkspaceId !== undefined}
              onRecovered={async () => {
                await policy.refetch();
              }}
              onCreated={async () => {
                await policy.refetch();
              }}
            />
          )}
        </>
      )}
    </SettingsPage>
  );
};

const settingsOf = (policy: WorkspaceAccessPolicy): WorkspacePolicySettings => ({
  mode: policy.mode,
  signIn: policy.signIn,
  allowedConnectionIds: policy.allowedConnectionIds,
  requireMfa: policy.requireMfa,
  idleMinutes: policy.idleMinutes,
  maxAgeHours: policy.maxAgeHours,
  mfaMaxAgeMinutes: policy.mfaMaxAgeMinutes,
});

const PolicyEditor = ({
  policy,
  workspaceId,
  slug,
  companySession,
  mayEnforce,
  readFailed,
  saved,
  setSaved,
  refresh,
}: {
  readonly policy: WorkspaceAccessPolicy;
  readonly workspaceId: string;
  readonly slug: string;
  readonly companySession: boolean;
  readonly mayEnforce: boolean;
  readonly readFailed: boolean;
  readonly saved: boolean;
  readonly setSaved: (saved: boolean) => void;
  readonly refresh: () => Promise<void>;
}): React.JSX.Element => {
  const api = useApi();
  const { user } = useSession();
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const [draft, setDraft] = useState(() => settingsOf(policy));
  const [preview, setPreview] = useState<WorkspacePolicyPreview | null>(null);
  const [tested, setTested] = useState<WorkspacePolicyTest | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const task = useSecurityTask((failure) => {
    if (
      isApiError(failure) &&
      ['WORKSPACE_SECURITY_CHANGED', 'WORKSPACE_MFA_NOT_FOUND'].includes(failure.code)
    ) {
      setPreview(null);
      setTested(null);
      setConfirmed(false);
      void refresh();
    }
  });
  const providers = useQuery({
    queryKey: ['workspace-security', user.id, workspaceId, 'providers'],
    queryFn: async ({ signal }) => await api.companyConnections(workspaceId, signal),
  });
  const change = <K extends keyof WorkspacePolicySettings>(
    field: K,
    value: WorkspacePolicySettings[K],
  ): void => {
    setDraft({ ...draft, [field]: value });
    setPreview(null);
    setTested(null);
    setConfirmed(false);
    setSaved(false);
    setInvalid(false);
    task.setProblem(null);
  };
  const valid = (): boolean => {
    const providerIds =
      providers.data?.data.filter((item) => item.ready && item.enabled).map((item) => item.id) ??
      [];
    const okay =
      Value.Check(WorkspacePolicySettings, draft) &&
      (draft.signIn !== 'company' ||
        (draft.allowedConnectionIds.length > 0 &&
          draft.allowedConnectionIds.every((id) => providerIds.includes(id))));
    setInvalid(!okay);
    return okay;
  };
  const readPreview = (before?: string): void => {
    if (!valid()) return;
    void task.run(
      () =>
        api.previewWorkspacePolicy(workspaceId, {
          revision: policy.revision,
          policy: draft,
          ...(before === undefined ? {} : { before }),
        }),
      (result) => {
        setPreview(
          before === undefined || preview === null
            ? result
            : {
                ...result,
                examples: {
                  ...result.examples,
                  data: [...preview.examples.data, ...result.examples.data],
                },
              },
        );
      },
    );
  };
  const testPolicy = (resume = false): void => {
    if (!valid()) return;
    void task.run(
      () =>
        api.testWorkspacePolicy(workspaceId, {
          revision: policy.revision,
          policy: draft,
          ...(resume && tested !== null
            ? { testId: tested.testId, testToken: tested.testToken }
            : {}),
        }),
      (result) => {
        setTested(result);
        setConfirmed(false);
      },
    );
  };
  return (
    <>
      <SettingsCard
        title={t('security.policy.title')}
        description={t(mayEnforce ? 'security.policy.testHint' : 'security.policy.ownerOnly')}
      >
        <fieldset disabled={task.busy || readFailed} className="min-w-0">
          <SettingsRow label={t('security.policy.mode')} wide>
            <Select
              aria-label={t('security.policy.mode')}
              value={draft.mode}
              onChange={(event) => {
                change('mode', event.currentTarget.value === 'enforced' ? 'enforced' : 'off');
              }}
            >
              <option value="off">{t('security.policy.off')}</option>
              <option value="enforced">{t('security.policy.enforced')}</option>
            </Select>
          </SettingsRow>
          <SettingsRow
            label={t('security.policy.signIn')}
            description={t('security.policy.guests')}
            wide
          >
            <Select
              aria-label={t('security.policy.signIn')}
              value={draft.signIn}
              onChange={(event) => {
                change('signIn', event.currentTarget.value === 'company' ? 'company' : 'any');
              }}
            >
              <option value="any">{t('security.policy.any')}</option>
              <option value="company">{t('security.policy.company')}</option>
            </Select>
          </SettingsRow>
          {draft.signIn === 'company' && (
            <div className="flex flex-col gap-3 border-t-hairline border-border-subtle px-6 py-5 max-narrow:px-4">
              <h3 className="text-label text-ink">{t('security.policy.providers')}</h3>
              <p className="text-body text-ink-muted">{t('security.policy.providersHint')}</p>
              {providers.isError ? (
                <>
                  <SecurityProblem text={describe(providers.error)} />
                  <Button
                    onClick={() => {
                      void providers.refetch();
                    }}
                  >
                    {t('common.retry')}
                  </Button>
                </>
              ) : providers.data === undefined ? (
                <SecurityLoading failed={false} retry={() => undefined} />
              ) : (
                <ProviderChoices
                  choices={providers.data.data}
                  selected={draft.allowedConnectionIds}
                  change={(ids) => {
                    change('allowedConnectionIds', ids);
                  }}
                />
              )}
              {providers.data?.data.every((item) => !item.ready || !item.enabled) && (
                <p className="text-body text-ink-muted">{t('security.policy.noProviders')}</p>
              )}
              <a
                className="text-label text-accent-text underline"
                href={href('settings', { slug, section: 'company' })}
              >
                {t('security.policy.configure')}
              </a>
            </div>
          )}
          <SettingsRow label={t('security.policy.requireMfa')}>
            <Checkbox
              aria-label={t('security.policy.requireMfa')}
              checked={draft.requireMfa}
              onChange={(event) => {
                change('requireMfa', event.currentTarget.checked);
              }}
            />
          </SettingsRow>
          <div className="grid grid-cols-3 gap-4 border-t-hairline border-border-subtle px-6 py-5 max-narrow:grid-cols-1 max-narrow:px-4">
            {(['idleMinutes', 'maxAgeHours', 'mfaMaxAgeMinutes'] as const).map((field) => (
              <TextField
                key={field}
                type="number"
                min={field === 'maxAgeHours' ? 1 : 5}
                max={field === 'maxAgeHours' ? 720 : 1440}
                step={1}
                label={t(
                  field === 'idleMinutes'
                    ? 'security.policy.idle'
                    : field === 'maxAgeHours'
                      ? 'security.policy.maxAge'
                      : 'security.policy.mfaAge',
                )}
                hint={t('security.policy.noLimit')}
                value={draft[field] ?? ''}
                onChange={(event) => {
                  change(
                    field,
                    event.currentTarget.value === '' ? null : Number(event.currentTarget.value),
                  );
                }}
              />
            ))}
          </div>
        </fieldset>
        <div className="flex flex-col gap-3 border-t-hairline border-border-subtle px-6 py-4 max-narrow:px-4">
          {readFailed && (
            <SecurityLoading
              failed
              retry={() => {
                void refresh();
              }}
            />
          )}
          {invalid && <SecurityProblem text={t('security.policy.invalid')} />}
          <SecurityProblem text={task.problem} />
          {saved && (
            <p role="status" className="text-body text-success-text">
              {t('security.saved')}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              busy={task.busy}
              disabled={readFailed}
              onClick={() => {
                readPreview();
              }}
            >
              {t('security.policy.preview')}
            </Button>
            <Button
              disabled={task.busy}
              onClick={() => {
                void refresh();
                void providers.refetch();
              }}
            >
              {t('security.refresh')}
            </Button>
          </div>
        </div>
      </SettingsCard>
      {preview !== null && (
        <SettingsCard title={t('security.policy.impact')}>
          <div className="flex flex-col gap-4 px-6 py-5 max-narrow:px-4">
            <p className="text-body text-ink">
              {t('security.policy.counts', {
                members: preview.affectedMemberCount,
                guests: preview.affectedGuestCount,
                sessions: preview.affectedSessionCount,
              })}
            </p>
            <ul className="flex flex-col gap-2">
              {preview.examples.data.map((person) => (
                <li
                  key={person.userId}
                  className="flex flex-wrap justify-between gap-2 text-body text-ink"
                >
                  <span>{person.displayName}</span>
                  <span className="text-ink-muted">{t(`security.status.${person.state}`)}</span>
                </li>
              ))}
            </ul>
            {preview.examples.nextCursor !== null && (
              <div>
                <Button
                  busy={task.busy}
                  onClick={() => {
                    readPreview(preview.examples.nextCursor ?? undefined);
                  }}
                >
                  {t('security.policy.more')}
                </Button>
              </div>
            )}
            {draft.mode === 'enforced' && !preview.ownerRecoveryReady && (
              <>
                <p role="status" className="text-body text-warning-text">
                  {t('security.policy.recoveryNeeded')}
                </p>
                <a
                  className="text-label text-accent-text underline"
                  href={href('settings', { slug, section: 'members' })}
                >
                  {t('security.policy.owners')}
                </a>
              </>
            )}
            <div>
              {mayEnforce && (
                <Button
                  busy={task.busy}
                  disabled={readFailed}
                  onClick={() => {
                    testPolicy();
                  }}
                >
                  {t('security.policy.test')}
                </Button>
              )}
            </div>
          </div>
        </SettingsCard>
      )}
      {mayEnforce && tested !== null && (
        <PolicyTestResult
          key={tested.testId}
          tested={tested}
          workspaceId={workspaceId}
          slug={slug}
          companySession={companySession}
          busy={task.busy}
          resume={() => {
            testPolicy(true);
          }}
        />
      )}
      {mayEnforce && preview !== null && tested !== null && tested.status.state === 'allowed' && (
        <PolicySave
          tested={tested}
          allowed={draft.mode !== 'enforced' || preview.ownerRecoveryReady}
          confirmed={confirmed}
          setConfirmed={setConfirmed}
          busy={task.busy}
          save={() => {
            void task.run(
              () =>
                api.updateWorkspacePolicy(workspaceId, {
                  revision: policy.revision,
                  policy: draft,
                  testId: tested.testId,
                  testToken: tested.testToken,
                }),
              async () => {
                setTested(null);
                setPreview(null);
                setSaved(true);
                await refresh();
              },
            );
          }}
        />
      )}
    </>
  );
};

const ProviderChoices = ({
  choices,
  selected,
  change,
}: {
  readonly choices: readonly CompanyIdentityConnection[];
  readonly selected: readonly string[];
  readonly change: (ids: string[]) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <fieldset aria-label={t('security.policy.providers')} className="flex flex-col gap-3">
      {selected
        .filter((id) => !choices.some((provider) => provider.id === id))
        .map((id) => (
          <label key={id} className="flex items-start gap-3 text-body text-ink">
            <Checkbox
              checked
              onChange={() => {
                change(selected.filter((selectedId) => selectedId !== id));
              }}
            />
            <span>{t('security.policy.unavailable')}</span>
          </label>
        ))}
      {choices.map((provider) => (
        <label key={provider.id} className="flex items-start gap-3 text-body text-ink">
          <Checkbox
            checked={selected.includes(provider.id)}
            disabled={
              (!provider.ready ||
                !provider.enabled ||
                selected.length >= WORKSPACE_POLICY_CONNECTIONS_MAX) &&
              !selected.includes(provider.id)
            }
            onChange={(event) => {
              change(
                event.currentTarget.checked
                  ? [...selected, provider.id]
                  : selected.filter((id) => id !== provider.id),
              );
            }}
          />
          <span>
            {provider.name}
            {(!provider.ready || !provider.enabled) && (
              <span className="block text-caption text-ink-muted">
                {t('security.policy.unavailable')}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
};

const PolicyTestResult = ({
  tested,
  workspaceId,
  slug,
  companySession,
  busy,
  resume,
}: {
  readonly tested: WorkspacePolicyTest;
  readonly workspaceId: string;
  readonly slug: string;
  readonly companySession: boolean;
  readonly busy: boolean;
  readonly resume: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const expired = useExpired(tested.expiresAt);
  return (
    <>
      <SettingsCard title={t(`security.status.${tested.status.state}`)}>
        <div className="flex flex-col gap-3 px-6 py-5 max-narrow:px-4">
          {expired ? (
            <p role="status" className="text-body text-warning-text">
              {t('security.code.expired')}
            </p>
          ) : tested.status.state === 'allowed' ? (
            <p role="status" className="text-body text-success-text">
              {t('security.policy.testPassed')}
            </p>
          ) : (
            <>
              <p className="text-body text-ink-muted">
                {t(
                  tested.status.state === 'expired'
                    ? 'security.access.expired'
                    : 'security.policy.testHint',
                )}
              </p>
              {(tested.status.state === 'sign_in_required' ||
                tested.status.state === 'expired') && (
                <a
                  className={buttonStyle('secondary')}
                  href={`${href('signIn')}?workspace=${encodeURIComponent(slug)}&independent=${tested.status.state === 'expired' ? '1' : '0'}`}
                >
                  {t('security.signIn')}
                </a>
              )}
              <div>
                <Button busy={busy} onClick={resume}>
                  {t('security.policy.resume')}
                </Button>
              </div>
            </>
          )}
        </div>
      </SettingsCard>
      {!expired &&
        (tested.status.state === 'mfa_required' ||
          tested.status.state === 'mfa_enrollment_required') && (
          <WorkspaceMfa
            workspaceId={workspaceId}
            companySession={companySession}
            policyTestId={tested.testId}
            onVerified={resume}
          />
        )}
    </>
  );
};

const PolicySave = ({
  tested,
  allowed,
  confirmed,
  setConfirmed,
  busy,
  save,
}: {
  readonly tested: WorkspacePolicyTest;
  readonly allowed: boolean;
  readonly confirmed: boolean;
  readonly setConfirmed: (value: boolean) => void;
  readonly busy: boolean;
  readonly save: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const expired = useExpired(tested.expiresAt);
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-start gap-3 text-body text-ink">
        <Checkbox
          checked={confirmed}
          disabled={busy || expired || !allowed}
          onChange={(event) => {
            setConfirmed(event.currentTarget.checked);
          }}
        />
        <span>{t('security.policy.confirm')}</span>
      </label>
      <div>
        <Button
          variant="primary"
          busy={busy}
          disabled={!confirmed || !allowed || expired}
          onClick={save}
        >
          {t('security.policy.save')}
        </Button>
      </div>
    </div>
  );
};
