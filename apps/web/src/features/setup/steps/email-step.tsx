/**
 * Step 5: email (UX §11, D-179 §4.3). The try *is* the administrator's verification letter: it is sent
 * for real, through the relay as typed, and kept only if the relay takes it. A try that stops says where
 * — one line per stage, a tick, a cross, or a hollow circle for what was never reached — read from the
 * reason, since each reason is where the try stopped.
 */
import type { ProbeResult } from '@purlay/types';
import { useState } from 'react';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { TextField } from '../../../ui/text-field';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { MAIL_STAGES, REASONS, type MailStage } from '../errors';
import {
  Actions,
  FailureNote,
  MailServerField,
  Note,
  ProbeFailure,
  StepHeader,
  useHeadingFocusOnChange,
} from '../parts';
import type { StepProps } from './props';

/** How far a stage got: passed, the one the try stopped at, or never reached. */
const DONE = 0;
const FAILED = 1;
const NOT_REACHED = 2;

const STAGE_TONES = ['text-success-text', 'text-danger-text', 'text-ink-muted'] as const;

/** The stages' lines: `reached` is how many were passed (all four on success). */
const Stages = ({ stoppedAt }: { readonly stoppedAt: MailStage | 'all' }): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <ol className="flex flex-col gap-1">
      {MAIL_STAGES.map((key, index) => {
        const status =
          stoppedAt === 'all' || index < stoppedAt
            ? DONE
            : index === stoppedAt
              ? FAILED
              : NOT_REACHED;
        return (
          <li key={key} className={cn('flex items-center gap-2 text-label', STAGE_TONES[status])}>
            <Icon
              name={status === DONE ? 'confirm' : status === FAILED ? 'close' : 'info'}
              size="md"
            />
            <span>{t(key)}</span>
            <VisuallyHidden>
              {status === DONE
                ? t('setup.email.stage.done')
                : status === FAILED
                  ? t('setup.email.stage.failed')
                  : t('setup.email.stage.skipped')}
            </VisuallyHidden>
          </li>
        );
      })}
    </ol>
  );
};

export const EmailStep = ({ state, done, onBack, onNext }: StepProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const { client, refresh, lose } = useSetup();
  const connected = state.settings.smtp !== null && !state.needsReentry.includes('smtp');
  const [editing, setEditing] = useState(false);
  const [smtpUrl, setSmtpUrl] = useState('');
  const [from, setFrom] = useState(state.settings.smtp?.from ?? '');
  const [allowPlaintext, setAllowPlaintext] = useState(
    state.settings.smtp?.allowPlaintext ?? false,
  );
  const [busy, setBusy] = useState<'try' | 'skip' | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useHeadingFocusOnChange(
    connected && !editing && result === null ? 'connected' : result?.ok === true ? 'sent' : 'form',
  );

  const admin = state.admin;
  const address = admin?.email ?? '';

  const fail = (caught: unknown): void => {
    setFailure(caught);
    if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
  };

  const submit = async (): Promise<void> => {
    setBusy('try');
    setFailure(null);
    try {
      const value = await client.smtp({
        smtpUrl: smtpUrl.trim(),
        from: from.trim(),
        allowPlaintext,
        locale: locale === 'tr' ? 'tr' : 'en',
        save: true,
      });
      setResult(value);
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
      await client.skipSmtp();
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

  if (connected && !editing && result === null) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeader title={t('setup.email.title')} lede={t('setup.email.lede')} />
        <Note tone="good">{t('setup.email.connected')}</Note>
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

  // The relay took the letter and kept: the person reads that it went, then goes on.
  if (result?.ok === true) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeader title={t('setup.email.title')} lede={t('setup.email.lede')} />
        <div className="flex max-w-dialog flex-col gap-4">
          <Stages stoppedAt="all" />
          <Note tone="good">
            {admin?.emailVerified === true
              ? t('setup.email.sentTest', { email: address })
              : t('setup.email.sent', { email: address })}
          </Note>
        </div>
        <Actions>
          <Button
            variant="primary"
            onClick={() => {
              void refresh();
            }}
          >
            {t('setup.continue')}
          </Button>
        </Actions>
      </div>
    );
  }

  const failed = result;
  const words = failed === null ? null : REASONS[failed.reason];
  const field = words?.field ?? null;
  const filled = smtpUrl.trim() !== '' && from.trim() !== '';

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (filled) void submit();
      }}
      className="flex flex-col gap-6"
    >
      <StepHeader title={t('setup.email.title')} lede={t('setup.email.lede')} />
      <div className="flex max-w-dialog flex-col gap-4">
        {state.needsReentry.includes('smtp') && <Note tone="warn">{t('setup.email.reentry')}</Note>}
        <MailServerField
          value={smtpUrl}
          invalid={field === 'smtpUrl'}
          onChange={(value) => {
            setSmtpUrl(value);
            setResult(null);
          }}
        />
        <TextField
          label={t('setup.email.from')}
          hint={t('setup.email.fromHint')}
          value={from}
          autoComplete="off"
          spellCheck={false}
          maxLength={254}
          invalid={field === 'from'}
          onChange={(event) => {
            setFrom(event.target.value);
            setResult(null);
          }}
        />
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={allowPlaintext}
            onChange={(event) => {
              setAllowPlaintext(event.target.checked);
            }}
            className="mt-1"
          />
          <span className="flex flex-col">
            <span className="text-label text-ink">{t('setup.email.plaintext')}</span>
            <span className="text-caption text-ink-muted">{t('setup.email.plaintextHint')}</span>
          </span>
        </label>
        {address !== '' && (
          <p className="text-body text-ink">
            {admin?.emailVerified === true
              ? t('setup.email.letterVerified', { email: address })
              : t('setup.email.letter', { email: address })}
          </p>
        )}
        {failed !== null && words !== null && (
          <>
            {words.stoppedAt !== null && <Stages stoppedAt={words.stoppedAt} />}
            <ProbeFailure result={failed} />
          </>
        )}
        {failure !== null && <FailureNote failure={failure} />}
        <p className="text-caption text-ink-muted">{t('setup.email.skipNote')}</p>
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
        <Button
          type="submit"
          variant="primary"
          busy={busy === 'try'}
          disabled={!filled || busy !== null}
        >
          {failed === null ? t('setup.email.try') : t('setup.tryAgain')}
        </Button>
      </Actions>
    </form>
  );
};
