/** Owner recovery keeps a purpose-bound reauthentication ticket only in this open tab. */
import { useState } from 'react';
import { Value } from '@sinclair/typebox/value';
import {
  RecoverWorkspacePolicyRequest,
  type WorkspacePolicyTest,
} from '@purlay/types/workspace-security';
import { useApi } from '../../../data/api-provider';
import { accountChanged } from '../../../data/errors';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button, buttonStyle } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { href } from '../../../router/routes';
import { useSession } from '../../session/session';
import { SettingsCard } from '../page';
import { SecretValue, SecurityProblem, useExpired, useSecurityTask } from './parts';

export const OwnerRecovery = ({
  workspaceId,
  slug,
  revision,
  companySession,
  onRecovered,
  onCreated,
}: {
  readonly workspaceId: string;
  readonly slug: string;
  readonly revision: string | null;
  readonly companySession: boolean;
  readonly onRecovered: () => Promise<void>;
  readonly onCreated?: () => Promise<void>;
}): React.JSX.Element => {
  const api = useApi();
  const { user } = useSession();
  const { t } = useI18n();
  const [secret, setSecret] = useState<string | null>(null);
  const [ticket, setTicket] = useState<WorkspacePolicyTest | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [typed, setTyped] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const task = useSecurityTask();
  const recover = (): void => {
    const [recoveryRevision, code, extra] = typed.trim().split('.');
    const input = { revision: recoveryRevision, recoveryCode: code };
    if (extra !== undefined || !Value.Check(RecoverWorkspacePolicyRequest, input)) {
      setInvalid(true);
      return;
    }
    void task.run(
      () => api.recoverWorkspacePolicy(workspaceId, input),
      async () => {
        setTyped('');
        setRecovering(false);
        setDone(true);
        await onRecovered();
      },
    );
  };
  const create = (): void => {
    void task.run(
      async () => {
        // New-tab authentication must still be the same canonical owner before a retained ticket is sent.
        if (ticket !== null) {
          const me = await api.me();
          if (me.user.id !== user.id || me.companyWorkspaceId !== undefined) throw accountChanged();
        }
        return await api.createWorkspacePolicyRecovery(workspaceId, {
          policyRevision: revision,
          ...(ticket === null ? {} : { testId: ticket.testId, testToken: ticket.testToken }),
        });
      },
      (result) => {
        setSecret(`${result.revision}.${result.recoveryCode}`);
        setDone(false);
      },
    );
  };
  const prepare = (): void => {
    void task.run(
      async () => {
        const policy = await api.workspacePolicy(workspaceId);
        return await api.testWorkspacePolicy(workspaceId, {
          purpose: 'recovery_setup',
          revision: policy.revision,
          policy: {
            mode: policy.mode,
            signIn: policy.signIn,
            allowedConnectionIds: policy.allowedConnectionIds,
            requireMfa: policy.requireMfa,
            idleMinutes: policy.idleMinutes,
            maxAgeHours: policy.maxAgeHours,
            mfaMaxAgeMinutes: policy.mfaMaxAgeMinutes,
          },
        });
      },
      (result) => {
        setTicket(result);
      },
    );
  };
  return (
    <SettingsCard title={t('security.recovery.title')} description={t('security.recovery.hint')}>
      <div className="flex flex-col gap-4 px-6 py-5 max-narrow:px-4">
        <SecurityProblem text={task.problem} />
        {done && (
          <p role="status" className="text-body text-success-text">
            {t('security.recovery.saved')}
          </p>
        )}
        {secret !== null ? (
          <>
            <p className="text-body text-ink-muted">{t('security.recovery.once')}</p>
            <SecretValue label={t('security.recovery.value')} value={secret} />
            <div>
              <Button
                variant="primary"
                onClick={() => {
                  setSecret(null);
                  setTicket(null);
                  void onCreated?.();
                }}
              >
                {t('security.recovery.done')}
              </Button>
            </div>
          </>
        ) : ticket !== null ? (
          <RecoverySetup
            ticket={ticket}
            slug={slug}
            busy={task.busy}
            complete={create}
            cancel={() => {
              setTicket(null);
            }}
          />
        ) : companySession ? (
          <>
            <p className="text-body text-ink-muted">{t('security.independentHint')}</p>
            <div>
              <Button busy={task.busy} onClick={prepare}>
                {t('security.recovery.prepare')}
              </Button>
            </div>
          </>
        ) : recovering ? (
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              recover();
            }}
            className="flex flex-col gap-3"
          >
            <TextField
              label={t('security.recovery.value')}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              disabled={task.busy}
              {...(invalid ? { error: t('security.recovery.invalid') } : {})}
              onChange={(event) => {
                setTyped(event.currentTarget.value);
                setInvalid(false);
              }}
            />
            <div className="flex flex-wrap gap-3">
              <Button variant="primary" type="submit" busy={task.busy}>
                {t('security.recovery.submit')}
              </Button>
              <Button
                disabled={task.busy}
                onClick={() => {
                  setRecovering(false);
                  setTyped('');
                }}
              >
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-3">
            <Button busy={task.busy} onClick={create}>
              {t('security.recovery.create')}
            </Button>
            <Button
              disabled={task.busy}
              onClick={() => {
                setRecovering(true);
              }}
            >
              {t('security.recovery.open')}
            </Button>
          </div>
        )}
      </div>
    </SettingsCard>
  );
};

const RecoverySetup = ({
  ticket,
  slug,
  busy,
  complete,
  cancel,
}: {
  readonly ticket: WorkspacePolicyTest;
  readonly slug: string;
  readonly busy: boolean;
  readonly complete: () => void;
  readonly cancel: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const expired = useExpired(ticket.expiresAt);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-body text-ink-muted">{t('security.recovery.keepOpen')}</p>
      {expired && (
        <p role="status" className="text-body text-warning-text">
          {t('security.code.expired')}
        </p>
      )}
      <div className="flex flex-wrap gap-3">
        <a
          className={buttonStyle('secondary')}
          target="_blank"
          rel="noopener noreferrer"
          href={`${href('signIn')}?independent=1&workspace=${encodeURIComponent(slug)}`}
        >
          {t('security.recovery.signInTab')}
        </a>
        <Button variant="primary" busy={busy} disabled={expired} onClick={complete}>
          {t('security.recovery.continue')}
        </Button>
        <Button disabled={busy} onClick={cancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
