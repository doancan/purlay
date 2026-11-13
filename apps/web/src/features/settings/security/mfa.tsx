/** Own workspace factors; company sessions never call global credential management. */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  WorkspaceMfaChallenge,
  WorkspaceMfaEnrollment,
  WorkspaceMfaRecoveryCodes,
  WorkspaceMfaVerified,
  WorkspaceMfaPurpose,
} from '@purlay/types/workspace-security';
import { useApi } from '../../../data/api-provider';
import { accountChanged, isApiError } from '../../../data/errors';
import { useI18n } from '../../../i18n/i18n-provider';
import { TextField } from '../../../ui/text-field';
import { Button } from '../../../ui/button';
import { SettingsCard, SettingsPage } from '../page';
import { TwoFactorQr } from '../pages/two-factor-qr';
import { useSession } from '../../session/session';
import { useWorkspace } from '../../shell/workspace';
import {
  SecurityLoading,
  SecurityProblem,
  SecretValue,
  useExpired,
  useSecurityTask,
} from './parts';

type Action = Exclude<WorkspaceMfaPurpose, 'enroll'>;
type Step =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'challenge';
      readonly challenge: WorkspaceMfaChallenge;
      readonly action: Action;
    }
  | { readonly kind: 'enroll'; readonly enrollment: WorkspaceMfaEnrollment }
  | { readonly kind: 'global' }
  | { readonly kind: 'codes'; readonly codes: WorkspaceMfaRecoveryCodes };

export const WorkspaceMfaPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user, companyWorkspaceId } = useSession();
  return (
    <SettingsPage title={t('security.self.title')} description={t('security.self.description')}>
      <WorkspaceMfa
        key={`${user.id}:${workspace.id}:${companyWorkspaceId ?? 'independent'}`}
        workspaceId={workspace.id}
        companySession={companyWorkspaceId !== undefined}
      />
    </SettingsPage>
  );
};

export const WorkspaceMfa = ({
  workspaceId,
  companySession,
  policyTestId,
  onVerified,
}: {
  readonly workspaceId: string;
  readonly companySession: boolean;
  readonly policyTestId?: string;
  readonly onVerified?: () => void | Promise<void>;
}): React.JSX.Element => {
  const api = useApi();
  const { user } = useSession();
  const { t } = useI18n();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [done, setDone] = useState(false);
  const task = useSecurityTask((failure) => {
    if (
      isApiError(failure) &&
      ['WORKSPACE_SECURITY_CHANGED', 'WORKSPACE_MFA_NOT_FOUND'].includes(failure.code)
    ) {
      setStep({ kind: 'idle' });
      void inventory.refetch();
    }
  });
  const inventory = useQuery({
    queryKey: ['workspace-security', user.id, workspaceId, 'mfa'],
    queryFn: async ({ signal }) => await api.myWorkspaceMfa(workspaceId, signal),
  });
  const refresh = async (): Promise<void> => {
    await inventory.refetch();
  };
  if (inventory.data === undefined)
    return (
      <SettingsCard title={t('security.factor.title')}>
        <SecurityLoading
          failed={inventory.isError}
          retry={() => {
            void refresh();
          }}
        />
      </SettingsCard>
    );
  const mine = inventory.data;
  const revision = mine.status.policyRevision;
  const start = (action: Action): void => {
    setDone(false);
    void task.run(
      () =>
        api.startWorkspaceMfaChallenge(workspaceId, {
          policyRevision: revision,
          purpose: action,
          factorScope: 'workspace',
          ...(action === 'policy_test' && policyTestId !== undefined
            ? { testId: policyTestId }
            : {}),
        }),
      (challenge) => {
        setStep({ kind: 'challenge', challenge, action });
      },
    );
  };
  const enroll = (authorizationChallengeId?: string): void => {
    void task.run(
      () =>
        api.startWorkspaceMfaEnrollment(workspaceId, {
          policyRevision: revision,
          factorRevision: mine.factor?.revision ?? null,
          ...(authorizationChallengeId === undefined ? {} : { authorizationChallengeId }),
        }),
      (enrollment) => {
        setStep({ kind: 'enroll', enrollment });
      },
    );
  };
  const verified = async (result: WorkspaceMfaVerified): Promise<void> => {
    if (result.recoveryCodes !== undefined) setStep({ kind: 'codes', codes: result.recoveryCodes });
    else {
      setStep({ kind: 'idle' });
      setDone(true);
      await onVerified?.();
    }
    await refresh();
  };
  const submit = (
    challenge: WorkspaceMfaChallenge,
    action: WorkspaceMfaPurpose,
    code: string,
    recovery: boolean,
  ): void => {
    void task.run(
      async () => {
        const result = recovery
          ? await api.recoverWorkspaceMfa(workspaceId, { challengeId: challenge.challengeId, code })
          : await api.verifyWorkspaceMfa(workspaceId, { challengeId: challenge.challengeId, code });
        if (!task.current()) throw accountChanged();
        const authorization = {
          policyRevision: revision,
          factorRevision: challenge.factorRevision,
          authorizationChallengeId: challenge.challengeId,
        };
        if (action === 'disable')
          return {
            kind: 'disabled' as const,
            value: await api.disableWorkspaceMfa(workspaceId, authorization),
          };
        if (action === 'recovery_codes')
          return {
            kind: 'codes' as const,
            value: await api.newWorkspaceMfaRecoveryCodes(workspaceId, authorization),
          };
        if (action === 'rotate')
          return {
            kind: 'enroll' as const,
            value: await api.startWorkspaceMfaEnrollment(workspaceId, {
              policyRevision: revision,
              factorRevision: challenge.factorRevision,
              authorizationChallengeId: challenge.challengeId,
            }),
          };
        return { kind: 'verified' as const, value: result };
      },
      async (result) => {
        if (result.kind === 'codes') setStep({ kind: 'codes', codes: result.value });
        else if (result.kind === 'enroll') setStep({ kind: 'enroll', enrollment: result.value });
        else if (result.kind === 'disabled') {
          setStep({ kind: 'idle' });
          setDone(true);
          await refresh();
        } else await verified(result.value);
      },
    );
  };
  const cancel = (): void => {
    setStep({ kind: 'idle' });
    task.setProblem(null);
  };
  return (
    <SettingsCard title={t('security.factor.title')} description={t('security.factor.scope')}>
      <div className="flex flex-col gap-4 px-6 py-5 max-narrow:px-4">
        {inventory.isError && (
          <SecurityLoading
            failed
            retry={() => {
              void refresh();
            }}
          />
        )}
        <SecurityProblem text={task.problem} />
        {done && (
          <p role="status" className="text-body text-success-text">
            {t('security.factor.confirmed')}
          </p>
        )}
        {step.kind === 'codes' ? (
          <section aria-label={t('security.codes.title')} className="flex flex-col gap-4">
            <h3 className="text-heading text-ink">{t('security.codes.title')}</h3>
            <p className="text-body text-ink-muted">{t('security.codes.hint')}</p>
            <SecretValue
              label={t('security.codes.copy')}
              value={step.codes.backupCodes.join('\n')}
            />
            <div>
              <Button
                variant="primary"
                onClick={() => {
                  setStep({ kind: 'idle' });
                  setDone(true);
                  void onVerified?.();
                }}
              >
                {t('security.codes.done')}
              </Button>
            </div>
          </section>
        ) : step.kind === 'enroll' ? (
          <div className="flex flex-col gap-4">
            {mine.factor !== null && (
              <p className="text-body text-ink-muted">{t('security.factor.rotateHint')}</p>
            )}
            <p className="text-body text-ink">{t('security.factor.scan')}</p>
            <div className="flex flex-wrap items-start gap-6">
              <TwoFactorQr value={step.enrollment.totpURI} label={t('security.factor.qr')} />
              <div className="min-w-0 flex-1">
                <SecretValue
                  label={t('security.factor.key')}
                  value={new URL(step.enrollment.totpURI).searchParams.get('secret') ?? ''}
                />
              </div>
            </div>
            <p className="text-caption text-ink-muted">{t('security.factor.once')}</p>
            <MfaCodeForm
              key={step.enrollment.challenge.challengeId}
              challenge={step.enrollment.challenge}
              busy={task.busy}
              allowRecovery={false}
              onSubmit={(code, recovery) => {
                submit(step.enrollment.challenge, 'enroll', code, recovery);
              }}
              onCancel={cancel}
              onRestart={() => {
                if (mine.factor === null) enroll();
                else start('rotate');
              }}
            />
          </div>
        ) : step.kind === 'challenge' ? (
          <div className="flex flex-col gap-4">
            {step.action === 'disable' && (
              <p className="text-body text-ink-muted">{t('security.factor.stopHint')}</p>
            )}
            <MfaCodeForm
              key={step.challenge.challengeId}
              challenge={step.challenge}
              busy={task.busy}
              allowRecovery
              onSubmit={(code, recovery) => {
                submit(step.challenge, step.action, code, recovery);
              }}
              onCancel={cancel}
              onRestart={() => {
                start(step.action);
              }}
            />
          </div>
        ) : step.kind === 'global' ? (
          <GlobalCode
            busy={task.busy}
            submit={(code) => {
              void task.run(
                () => api.verifySignInCode({ code, kind: 'app' }),
                async () => {
                  setStep({ kind: 'idle' });
                  setDone(true);
                  await refresh();
                  await onVerified?.();
                },
              );
            }}
            cancel={cancel}
          />
        ) : (
          <>
            <p role="status" className="text-body text-ink">
              {t(mine.factor === null ? 'security.factor.off' : 'security.factor.on')}
            </p>
            {mine.pending !== null && (
              <p className="text-body text-ink-muted">{t('security.factor.pending')}</p>
            )}
            {mine.factor !== null && (
              <p className="text-caption text-ink-muted">
                {t('security.factor.remaining', { count: mine.recoveryCodesRemaining })}
              </p>
            )}
            <div className="flex flex-wrap gap-3">
              {mine.factor === null ? (
                <Button
                  variant="primary"
                  busy={task.busy}
                  onClick={() => {
                    enroll();
                  }}
                >
                  {t(mine.pending === null ? 'security.factor.start' : 'security.factor.restart')}
                </Button>
              ) : (
                <>
                  <Button
                    variant="primary"
                    busy={task.busy}
                    onClick={() => {
                      start(policyTestId === undefined ? 'step_up' : 'policy_test');
                    }}
                  >
                    {t('security.factor.verify')}
                  </Button>
                  <Button
                    disabled={task.busy}
                    onClick={() => {
                      start('rotate');
                    }}
                  >
                    {t('security.factor.rotate')}
                  </Button>
                  <Button
                    disabled={task.busy}
                    onClick={() => {
                      start('recovery_codes');
                    }}
                  >
                    {t('security.factor.codes')}
                  </Button>
                  <Button
                    variant="dangerQuiet"
                    disabled={task.busy}
                    onClick={() => {
                      start('disable');
                    }}
                  >
                    {t('security.factor.stop')}
                  </Button>
                </>
              )}
            </div>
            {mine.globalMfaAvailable && !companySession && (
              <div className="flex flex-col gap-2 border-t-hairline border-border-subtle pt-4">
                <h3 className="text-label text-ink">{t('security.global.title')}</h3>
                <p className="text-body text-ink-muted">{t('security.global.hint')}</p>
                <div>
                  <Button
                    disabled={task.busy}
                    onClick={() => {
                      setStep({ kind: 'global' });
                    }}
                  >
                    {t('security.global.action')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </SettingsCard>
  );
};

const MfaCodeForm = ({
  challenge,
  busy,
  allowRecovery,
  onSubmit,
  onCancel,
  onRestart,
}: {
  readonly challenge: WorkspaceMfaChallenge;
  readonly busy: boolean;
  readonly allowRecovery: boolean;
  readonly onSubmit: (code: string, recovery: boolean) => void;
  readonly onCancel: () => void;
  readonly onRestart: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const expired = useExpired(challenge.expiresAt);
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const value = code.trim();
        if (!(recovery ? /^[A-Za-z0-9_-]{22}$/ : /^[0-9]{6}$/).test(value)) {
          setInvalid(true);
          return;
        }
        onSubmit(value, recovery);
      }}
    >
      <TextField
        label={t(recovery ? 'security.code.recovery' : 'security.code')}
        value={code}
        autoComplete="one-time-code"
        inputMode={recovery ? 'text' : 'numeric'}
        maxLength={recovery ? 22 : 6}
        spellCheck={false}
        disabled={busy || expired}
        {...(invalid
          ? { error: t(recovery ? 'security.code.recoveryInvalid' : 'security.code.invalid') }
          : {})}
        onChange={(event) => {
          setCode(event.currentTarget.value);
          setInvalid(false);
        }}
      />
      <p className="text-caption text-ink-muted">{t('security.code.fresh')}</p>
      {expired && (
        <p role="status" className="text-body text-warning-text">
          {t('security.code.expired')}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        {expired ? (
          <Button variant="primary" busy={busy} onClick={onRestart}>
            {t('security.code.restart')}
          </Button>
        ) : (
          <Button variant="primary" type="submit" busy={busy}>
            {t('security.code.submit')}
          </Button>
        )}
        <Button disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        {allowRecovery && (
          <Button
            variant="ghost"
            disabled={busy || expired}
            onClick={() => {
              setRecovery(!recovery);
              setCode('');
              setInvalid(false);
            }}
          >
            {t(recovery ? 'security.code.useApp' : 'security.code.useRecovery')}
          </Button>
        )}
      </div>
    </form>
  );
};

const GlobalCode = ({
  busy,
  submit,
  cancel,
}: {
  readonly busy: boolean;
  readonly submit: (code: string) => void;
  readonly cancel: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      noValidate
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!/^[0-9]{6}$/.test(code)) {
          setInvalid(true);
          return;
        }
        submit(code);
      }}
    >
      <p className="text-body text-ink-muted">{t('security.global.hint')}</p>
      <TextField
        label={t('security.code')}
        value={code}
        inputMode="numeric"
        maxLength={6}
        autoComplete="one-time-code"
        disabled={busy}
        {...(invalid ? { error: t('security.code.invalid') } : {})}
        onChange={(event) => {
          setCode(event.currentTarget.value);
          setInvalid(false);
        }}
      />
      <div className="flex flex-wrap gap-3">
        <Button variant="primary" type="submit" busy={busy}>
          {t('security.code.submit')}
        </Button>
        <Button disabled={busy} onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
};
