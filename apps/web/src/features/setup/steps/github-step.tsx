/**
 * Step 4: GitHub (UX §11, D-179 §4.4). The pair is tried against GitHub before anything is kept, and
 * what GitHub answers is said in the words of its reason — never copied from a prototype: GitHub's
 * `bad_verification_code` is the *success* of a try, and is not a message here. The one thing a try
 * cannot check is the callback address, so the step shows it, to paste, and says what GitHub's own
 * error page means.
 */
import type { ProbeResult } from '@purlay/types';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { REASONS } from '../errors';
import {
  Actions,
  CopyField,
  FailureNote,
  Note,
  ProbeFailure,
  StepHeader,
  useHeadingFocusOnChange,
} from '../parts';
import type { StepProps } from './props';

export const GitHubStep = ({ state, done, onBack, onNext }: StepProps): React.JSX.Element => {
  const { t } = useI18n();
  const { client, refresh, lose } = useSetup();
  const connected = state.settings.github !== null && !state.needsReentry.includes('github');
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState(state.settings.github?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState<'try' | 'save' | 'skip' | null>(null);
  const [result, setResult] = useState<{
    readonly saved: boolean;
    readonly value: ProbeResult;
  } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useHeadingFocusOnChange(connected && !editing ? 'connected' : 'form');

  const fail = (caught: unknown): void => {
    setFailure(caught);
    if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
  };

  const run = async (save: boolean): Promise<void> => {
    setBusy(save ? 'save' : 'try');
    setFailure(null);
    try {
      const value = await client.github({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        save,
      });
      setResult({ saved: save, value });
      if (value.ok && save) await refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const skip = async (): Promise<void> => {
    setBusy('skip');
    setFailure(null);
    try {
      await client.skipGithub();
      await refresh();
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(null);
    }
  };

  const back =
    onBack === null ? null : (
      <Button variant="ghost" onClick={onBack}>
        {t('setup.back')}
      </Button>
    );

  if (connected && !editing) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeader title={t('setup.github.title')} lede={t('setup.github.lede')} />
        <Note tone="good">{t('setup.github.connected')}</Note>
        <Actions start={back}>
          <Button
            onClick={() => {
              setEditing(true);
            }}
          >
            {t('setup.tryAgain')}
          </Button>
          <Button
            variant="primary"
            onClick={
              done
                ? onNext
                : (): void => {
                    void refresh();
                  }
            }
          >
            {t('setup.continue')}
          </Button>
        </Actions>
      </div>
    );
  }

  const failed = result !== null && !result.value.ok ? result.value : null;
  const field = failed === null ? null : REASONS[failed.reason].field;
  const filled = clientId.trim() !== '' && clientSecret.trim() !== '';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (filled) void run(true);
      }}
      className="flex flex-col gap-6"
    >
      <StepHeader title={t('setup.github.title')} lede={t('setup.github.lede')} />
      <div className="flex max-w-dialog flex-col gap-6">
        <section className="flex flex-col gap-2">
          <h2 className="text-title">{t('setup.github.part1')}</h2>
          <p className="text-body text-ink-muted">{t('setup.github.part1Body')}</p>
          <CopyField label={t('setup.address.callback')} value={state.githubCallbackUrl} />
          <p className="text-caption text-ink-muted">{t('setup.github.callbackNote')}</p>
        </section>
        <section className="flex flex-col gap-4">
          <h2 className="text-title">{t('setup.github.part2')}</h2>
          {state.needsReentry.includes('github') && (
            <Note tone="warn">{t('setup.github.reentry')}</Note>
          )}
          <TextField
            label={t('setup.github.clientId')}
            value={clientId}
            autoComplete="off"
            spellCheck={false}
            maxLength={128}
            className="font-mono"
            invalid={field === 'clientId'}
            onChange={(event) => {
              setClientId(event.target.value);
              setResult(null);
            }}
          />
          <TextField
            label={t('setup.github.clientSecret')}
            type="password"
            value={clientSecret}
            autoComplete="off"
            spellCheck={false}
            maxLength={256}
            className="font-mono"
            hint={t('setup.github.secretHint')}
            invalid={field === 'clientSecret'}
            onChange={(event) => {
              setClientSecret(event.target.value);
              setResult(null);
            }}
          />
        </section>
        {failed !== null && <ProbeFailure result={failed} />}
        {result?.value.ok === true && !result.saved && (
          <Note tone="good">
            <strong className="font-medium">{t('setup.github.ok')}</strong>{' '}
            {t('setup.github.okNote')}
          </Note>
        )}
        {failure !== null && <FailureNote failure={failure} />}
        <p className="text-caption text-ink-muted">{t('setup.github.skipNote')}</p>
      </div>
      <Actions
        start={
          <>
            {back}
            <Button
              variant="ghost"
              busy={busy === 'skip'}
              disabled={busy !== null}
              onClick={() => {
                void skip();
              }}
            >
              {t('setup.skip')}
            </Button>
          </>
        }
      >
        {/* After a refusal the one primary action is the retry: a second "try" beside it is two
            buttons for one thing. */}
        {failed === null && (
          <Button
            busy={busy === 'try'}
            disabled={!filled || busy !== null}
            onClick={() => {
              void run(false);
            }}
          >
            {t('setup.github.try')}
          </Button>
        )}
        <Button
          type="submit"
          variant="primary"
          busy={busy === 'save'}
          disabled={!filled || busy !== null}
        >
          {failed === null ? t('setup.github.save') : t('setup.tryAgain')}
        </Button>
      </Actions>
    </form>
  );
};
