/**
 * Step 5: email (UX §11, D-179 §4.3). The try *is* the administrator's verification letter: it is sent
 * for real, through the relay as typed, and kept only if the relay takes it. A try that stops says where
 * — one line per stage, a tick, a cross, or a hollow circle for what was never reached — read from the
 * reason, since each reason is where the try stopped.
 */
import { EMAIL_MAX } from '@purlay/types';
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
import { Checkbox } from '../../../ui/checkbox';

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

/** Where a try stopped and what the service answered: the same for the form's try and a letter sent again. */
const MailFailure = ({
  result,
}: {
  readonly result: Extract<ProbeResult, { ok: false }>;
}): React.JSX.Element => {
  const { stoppedAt } = REASONS[result.reason];
  return (
    <>
      {stoppedAt !== null && <Stages stoppedAt={stoppedAt} />}
      <ProbeFailure result={result} />
    </>
  );
};

/**
 * The letter again, through the relay already kept: for the person whose first one never came, and who
 * cannot be asked for the relay's address a second time — it is never shown to a browser after it is
 * saved. A new letter's link replaces the old, which the sentence says; a relay that now refuses is said
 * the way a try's is, by where it stopped.
 */
const ResendLetter = ({
  address,
  verified,
}: {
  readonly address: string;
  readonly verified: boolean;
}): React.JSX.Element => {
  const { t, locale } = useI18n();
  const { client, lose } = useSetup();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ProbeResult | null>(null);
  // Which letter went, as the server's state says when it answered — not as this screen was drawn.
  const [wasVerified, setWasVerified] = useState(verified);
  const [failure, setFailure] = useState<unknown>(null);

  const send = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    // The last answer is not this one's: a "sent" that was true a minute ago is not shown beside a new try.
    setOutcome(null);
    try {
      const result = await client.resendSmtp(locale === 'tr' ? 'tr' : 'en');
      if (result.ok) {
        // The address may have been verified since this screen was drawn — in another tab — and then the
        // server sent a test message, not a link. Read it alone: the wizard's own state is not refreshed
        // here, since a refresh would move the screen on (the mail step has passed) and take this note away.
        try {
          setWasVerified((await client.state()).admin?.emailVerified === true);
        } catch {
          setWasVerified(verified);
        }
      }
      setOutcome(result);
    } catch (caught) {
      setFailure(caught);
      if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
    } finally {
      setBusy(false);
    }
  };

  // The server could not try what is kept (its sender or address no longer passes the rules): nothing
  // here can change it — the form behind *Try again* can.
  const cannotBeTried = isSetupFailure(failure) && failure.code === 'VALIDATION_FAILED';

  return (
    <div className="flex max-w-dialog flex-col gap-3">
      <div>
        <Button
          busy={busy}
          disabled={busy}
          onClick={() => {
            void send();
          }}
        >
          {verified ? t('setup.email.resendTest') : t('setup.email.resend')}
        </Button>
      </div>
      {outcome?.ok === true && (
        <Note tone="good">
          {wasVerified
            ? t('setup.email.resentTest', { email: address })
            : t('setup.email.resent', { email: address })}
        </Note>
      )}
      {outcome?.ok === false && (
        <>
          <MailFailure result={outcome} />
          <p className="text-body text-ink-muted">{t('setup.email.resendFix')}</p>
        </>
      )}
      {cannotBeTried && <Note tone="warn">{t('setup.email.resendSavedInvalid')}</Note>}
      {failure !== null && !cannotBeTried && <FailureNote failure={failure} />}
    </div>
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
  // Fields of the last refusal that were edited since, so their sentences are gone.
  const [cleared, setCleared] = useState<readonly string[]>([]);

  useHeadingFocusOnChange(
    connected && !editing && result === null ? 'connected' : result?.ok === true ? 'sent' : 'form',
  );

  const admin = state.admin;
  const address = admin?.email ?? '';
  // What the server said about a field it would not try: said under that field, in this screen's words,
  // until that field is edited. A refusal whose every field is one of these two is wholly explained there.
  const refusedFields =
    isSetupFailure(failure) && failure.code === 'VALIDATION_FAILED'
      ? Object.keys(failure.fields)
      : [];
  const explained =
    refusedFields.length > 0 && refusedFields.every((one) => one === 'from' || one === 'smtpUrl');
  const fromRefused = refusedFields.includes('from') && !cleared.includes('from');
  const urlRefused = refusedFields.includes('smtpUrl') && !cleared.includes('smtpUrl');
  /** A field edited: its own refusal goes; a failure that was not about a field goes with any edit. */
  const edited = (field: 'from' | 'smtpUrl'): void => {
    setResult(null);
    if (explained) setCleared((now) => (now.includes(field) ? now : [...now, field]));
    else setFailure(null);
  };

  const fail = (caught: unknown): void => {
    setFailure(caught);
    if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
  };

  const submit = async (): Promise<void> => {
    setBusy('try');
    setFailure(null);
    setCleared([]);
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
        <Note tone={state.channels.email ? 'good' : 'warn'}>
          {state.channels.email ? t('setup.email.connected') : t('setup.email.untried')}
        </Note>
        {state.channels.email && (
          <ResendLetter address={address} verified={admin?.emailVerified === true} />
        )}
        {failure !== null && <FailureNote failure={failure} />}
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
            busy={busy === 'skip'}
            disabled={busy !== null}
            onClick={
              done
                ? onNext
                : (): void => {
                    void skip();
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
          <ResendLetter address={address} verified={admin?.emailVerified === true} />
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
          {...(urlRefused ? { error: t('setup.email.urlInvalid') } : {})}
          onChange={(value) => {
            setSmtpUrl(value);
            edited('smtpUrl');
          }}
        />
        <TextField
          label={t('setup.email.from')}
          // The refusal says it better, and in the same breath: the hint stands aside for it.
          {...(fromRefused ? {} : { hint: t('setup.email.fromHint') })}
          value={from}
          autoComplete="off"
          spellCheck={false}
          maxLength={EMAIL_MAX}
          invalid={field === 'from'}
          {...(fromRefused ? { error: t('setup.email.fromInvalid') } : {})}
          onChange={(event) => {
            setFrom(event.target.value);
            edited('from');
          }}
        />
        <label className="flex items-start gap-3">
          <Checkbox
            checked={allowPlaintext}
            onChange={(event) => {
              setAllowPlaintext(event.target.checked);
            }}
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
        {failed !== null && words !== null && <MailFailure result={failed} />}
        {failure !== null && !explained && <FailureNote failure={failure} />}
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
