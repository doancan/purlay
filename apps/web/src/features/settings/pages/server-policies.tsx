/**
 * Administration → Server's rules about people: who may make an account, how they sign in, how long a session
 * lasts, and who may make a workspace (D-179 §4.7, D-155, D-169, D-239, D-244). The sign-up, sign-in and session
 * policies apply as they are chosen; the
 * creators are saved with their button, since a list is typed. Each says in one sentence what it means, and
 * each is read by the server on the next request, so nothing needs a restart.
 */
import {
  SESSION_IDLE_TIMEOUT_HOURS,
  SESSION_MAX_AGE_DAYS,
  type ServerSettingsAnswer,
  type SessionIdleTimeoutHours,
  type SessionMaxAgeDays,
} from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Select } from '../../../ui/select';
import { isSetupFailure } from '../../setup/client';
import { Choices } from '../choices';
import { SaveOutcome, SettingsCard, SettingsRow, SettingsTextRow } from '../page';
import { useServerClient, type CreatorsChoice } from '../server-context';
import { ChangeFailure, useRefresh } from '../server-parts';

type Outcome = { readonly ok: boolean; readonly words: string } | null;

export const PolicyCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const [chosen, setChosen] = useState<'invite-only' | 'open' | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const change = async (signUp: 'invite-only' | 'open'): Promise<void> => {
    setChosen(signUp);
    setFailure(null);
    setOutcome(null);
    try {
      await client.policy({ signUp });
      await refresh();
      setOutcome({ ok: true, words: t('settings.server.policy.saved') });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setChosen(null);
    }
  };

  return (
    <SettingsCard
      title={t('settings.server.policy.title')}
      description={t('settings.server.policy.description')}
      footer={failure === null && outcome !== null ? <SaveOutcome outcome={outcome} /> : undefined}
    >
      <SettingsRow label={t('settings.server.policy.label')} wide>
        <Choices
          label={t('settings.server.policy.label')}
          value={chosen ?? view.settings.signUp}
          choices={[
            {
              value: 'invite-only',
              label: t('settings.server.policy.invite-only'),
              description: t('settings.server.policy.invite-only.body'),
            },
            {
              value: 'open',
              label: t('settings.server.policy.open'),
              description: t('settings.server.policy.open.body'),
            },
          ]}
          onChange={(value) => {
            void change(value);
          }}
        />
      </SettingsRow>
      {failure !== null && (
        <div className="px-6 pb-5 max-narrow:px-4">
          <ChangeFailure failure={failure} />
        </div>
      )}
    </SettingsCard>
  );
};

type SignInRule = 'requireTwoFactor' | 'passwordSignIn';

/**
 * How people sign in (D-239): whether an account with a password must turn on two-step verification, and
 * whether a password signs in at all. Each applies as it is chosen, on its own. Passwords can be turned off
 * only while GitHub or single sign-on serves, and the server refuses it otherwise — said here in its words, as
 * is a refusal because somebody else changed the page in between. Requiring the second step may hold the
 * administrator back too: the identity is read again, and the session gate says what to do.
 */
export const SignInPolicyCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const queries = useQueryClient();
  const [pending, setPending] = useState<{
    readonly rule: SignInRule;
    readonly on: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const providers = view.channels.github || view.channels.oidc;

  const change = async (rule: SignInRule, on: boolean): Promise<void> => {
    setPending({ rule, on });
    setFailure(null);
    setOutcome(null);
    try {
      await client.policy(
        rule === 'requireTwoFactor' ? { requireTwoFactor: on } : { passwordSignIn: on },
      );
      await refresh();
      // Whether the administrator is held back may have changed with it.
      await queries.invalidateQueries({ queryKey: keys.me });
      setOutcome({ ok: true, words: t('settings.server.signIn.saved') });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(null);
    }
  };

  const valueOf = (rule: SignInRule): 'on' | 'off' => {
    const on = pending?.rule === rule ? pending.on : view.settings[rule];
    return on ? 'on' : 'off';
  };

  return (
    <SettingsCard
      title={t('settings.server.signIn.title')}
      description={t('settings.server.signIn.description')}
      footer={failure === null && outcome !== null ? <SaveOutcome outcome={outcome} /> : undefined}
    >
      <SettingsRow label={t('settings.server.signIn.twoFactor')} wide>
        <Choices
          label={t('settings.server.signIn.twoFactor')}
          value={valueOf('requireTwoFactor')}
          choices={[
            {
              value: 'off',
              label: t('settings.server.signIn.twoFactor.off'),
              description: t('settings.server.signIn.twoFactor.off.body'),
            },
            {
              value: 'on',
              label: t('settings.server.signIn.twoFactor.on'),
              description: t('settings.server.signIn.twoFactor.on.body'),
            },
          ]}
          onChange={(value) => {
            void change('requireTwoFactor', value === 'on');
          }}
        />
      </SettingsRow>
      <SettingsRow
        label={t('settings.server.signIn.passwords')}
        wide
        {...(providers || !view.settings.passwordSignIn
          ? {}
          : { description: t('settings.server.signIn.passwords.needsProvider') })}
      >
        <Choices
          label={t('settings.server.signIn.passwords')}
          value={valueOf('passwordSignIn')}
          choices={[
            {
              value: 'on',
              label: t('settings.server.signIn.passwords.on'),
              description: t('settings.server.signIn.passwords.on.body'),
            },
            {
              value: 'off',
              label: t('settings.server.signIn.passwords.off'),
              description: t('settings.server.signIn.passwords.off.body'),
            },
          ]}
          onChange={(value) => {
            void change('passwordSignIn', value === 'on');
          }}
        />
      </SettingsRow>
      {failure !== null && (
        <div className="px-6 pb-5 max-narrow:px-4">
          <ChangeFailure failure={failure} />
        </div>
      )}
    </SettingsCard>
  );
};

/** What a select says for a rule that is off: no number is a duration. */
const OFF = 'off';

type LifetimeChange =
  | { readonly sessionIdleTimeoutHours: SessionIdleTimeoutHours | null }
  | { readonly sessionMaxAgeDays: SessionMaxAgeDays | null };

/**
 * How long a session lasts (D-244): signed out after so long unused, and signed in again after so long whatever
 * is done. Each a select of the durations the server takes (`@purlay/types`), applied as it is chosen, on its
 * own. Sessions already open follow from their next request, the native application's too.
 */
export const SessionLifetimeCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const idleId = useId();
  const maxAgeId = useId();
  const [pending, setPending] = useState<LifetimeChange | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);

  const change = async (next: LifetimeChange): Promise<void> => {
    setPending(next);
    setFailure(null);
    setOutcome(null);
    try {
      await client.policy(next);
      await refresh();
      setOutcome({ ok: true, words: t('settings.server.signIn.saved') });
    } catch (caught) {
      setFailure(caught);
    } finally {
      setPending(null);
    }
  };

  /** A duration in the words a person uses: weeks, days or hours, whichever divides it. */
  const hoursNamed = (hours: number): string =>
    hours % (24 * 7) === 0
      ? t('settings.server.lifetime.weeks', { count: hours / (24 * 7) })
      : hours % 24 === 0
        ? t('settings.server.lifetime.days', { count: hours / 24 })
        : t('settings.server.lifetime.hours', { count: hours });

  const idle =
    pending !== null && 'sessionIdleTimeoutHours' in pending
      ? pending.sessionIdleTimeoutHours
      : view.settings.sessionIdleTimeoutHours;
  const maxAge =
    pending !== null && 'sessionMaxAgeDays' in pending
      ? pending.sessionMaxAgeDays
      : view.settings.sessionMaxAgeDays;

  return (
    <SettingsCard
      title={t('settings.server.lifetime.title')}
      description={t('settings.server.lifetime.description')}
      footer={failure === null && outcome !== null ? <SaveOutcome outcome={outcome} /> : undefined}
    >
      <SettingsRow
        label={t('settings.server.lifetime.idle')}
        description={t('settings.server.lifetime.idle.hint')}
        htmlFor={idleId}
        fill
      >
        <Select
          id={idleId}
          className="w-full"
          value={idle === null ? OFF : String(idle)}
          onChange={(event) => {
            const chosen = SESSION_IDLE_TIMEOUT_HOURS.find(
              (hours) => String(hours) === event.target.value,
            );
            void change({ sessionIdleTimeoutHours: chosen ?? null });
          }}
        >
          <option value={OFF}>{t('settings.server.lifetime.idle.off')}</option>
          {SESSION_IDLE_TIMEOUT_HOURS.map((hours) => (
            <option key={hours} value={String(hours)}>
              {hoursNamed(hours)}
            </option>
          ))}
        </Select>
      </SettingsRow>
      <SettingsRow
        label={t('settings.server.lifetime.maxAge')}
        description={t('settings.server.lifetime.maxAge.hint')}
        htmlFor={maxAgeId}
        fill
      >
        <Select
          id={maxAgeId}
          className="w-full"
          value={maxAge === null ? OFF : String(maxAge)}
          onChange={(event) => {
            const chosen = SESSION_MAX_AGE_DAYS.find((days) => String(days) === event.target.value);
            void change({ sessionMaxAgeDays: chosen ?? null });
          }}
        >
          <option value={OFF}>{t('settings.server.lifetime.maxAge.off')}</option>
          {SESSION_MAX_AGE_DAYS.map((days) => (
            <option key={days} value={String(days)}>
              {hoursNamed(days * 24)}
            </option>
          ))}
        </Select>
      </SettingsRow>
      {failure !== null && (
        <div className="px-6 pb-5 max-narrow:px-4">
          <ChangeFailure failure={failure} />
        </div>
      )}
    </SettingsCard>
  );
};

/** A GitHub login, as the server takes one (D-155). */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

/** The logins typed, trimmed and without the empty ones. */
const loginsOf = (typed: string): string[] =>
  typed
    .split(',')
    .map((login) => login.trim())
    .filter((login) => login !== '');

export const CreatorsCard = ({
  view,
}: {
  readonly view: ServerSettingsAnswer;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const refresh = useRefresh();
  const now = view.settings.workspaceCreators;
  const [kind, setKind] = useState<'first' | 'anyone' | 'listed'>(now.kind);
  const [typed, setTyped] = useState(now.kind === 'listed' ? now.logins.join(', ') : '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [wrong, setWrong] = useState(false);

  const logins = loginsOf(typed);
  const listProblem =
    kind === 'listed' && (logins.length === 0 || !logins.every((login) => LOGIN.test(login)));
  const unchanged =
    kind === now.kind &&
    (kind !== 'listed' ||
      (now.kind === 'listed' &&
        [...now.logins].sort().join(',') ===
          [...new Set(logins.map((login) => login.toLowerCase()))].sort().join(',')));

  const save = async (): Promise<void> => {
    if (listProblem) {
      setWrong(true);
      return;
    }
    const choice: CreatorsChoice = kind === 'listed' ? { kind, logins } : { kind };
    setBusy(true);
    setFailure(null);
    setOutcome(null);
    try {
      await client.creators(choice);
      await refresh();
      setOutcome({ ok: true, words: t('settings.server.creators.saved') });
    } catch (caught) {
      if (isSetupFailure(caught) && 'workspaceCreators' in caught.fields) setWrong(true);
      else setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={t('settings.server.creators.title')}
      description={t('settings.server.creators.description')}
      footer={
        <>
          {failure === null ? (
            <SaveOutcome outcome={outcome} />
          ) : (
            <ChangeFailure failure={failure} />
          )}
          <Button
            variant="primary"
            busy={busy}
            disabled={busy || unchanged}
            onClick={() => {
              void save();
            }}
          >
            {t('settings.server.creators.save')}
          </Button>
        </>
      }
    >
      <SettingsRow label={t('settings.server.creators.label')} wide>
        <Choices
          label={t('settings.server.creators.label')}
          value={kind}
          choices={[
            {
              value: 'first',
              label: t('settings.server.creators.first'),
              description: t('settings.server.creators.first.body'),
            },
            {
              value: 'anyone',
              label: t('settings.server.creators.anyone'),
              description: t('settings.server.creators.anyone.body'),
            },
            {
              value: 'listed',
              label: t('settings.server.creators.listed'),
              description: t('settings.server.creators.listed.body'),
            },
          ]}
          onChange={(value) => {
            setKind(value);
            setWrong(false);
            setOutcome(null);
          }}
        />
      </SettingsRow>
      {kind === 'listed' && (
        <SettingsTextRow
          label={t('settings.server.creators.logins')}
          hint={t('settings.server.creators.loginsHint')}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          {...(wrong && listProblem ? { error: t('settings.server.creators.loginsError') } : {})}
          onChange={(event) => {
            setTyped(event.target.value);
            setWrong(false);
          }}
        />
      )}
    </SettingsCard>
  );
};
