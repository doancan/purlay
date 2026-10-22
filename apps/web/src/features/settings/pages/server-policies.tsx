/**
 * Administration → Server's two rules about people: who may make an account, and who may make a
 * workspace (D-179 §4.7, D-155, D-169). The sign-up policy applies as it is chosen; the creators are
 * saved with their button, since a list is typed. Each says in one sentence what it means, and each is
 * read by the server on the next request, so nothing needs a restart.
 */
import type { ServerSettingsAnswer } from '@purlay/types';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
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
      await client.policy(signUp);
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
