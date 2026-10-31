/**
 * Two-step verification (D-236), on Sessions & account — only for an account that has a password, which is what
 * it protects; the card says that GitHub, single sign-on and a link rely on their own provider.
 *
 * - **Turning it on**: the password first, then the key as a QR code, as text to type and as an `otpauth://`
 *   link, and a code from the app — nothing is on until that code is right. Then the backup codes, this once,
 *   with a button that copies them.
 * - **Turning it off** and **new backup codes** ask for the password each time.
 *
 * A wrong password is said on its field and a wrong code on its; a wait is told in minutes. The session in
 * this tab is the same one before and after: nothing here signs anybody out.
 */
import type { TwoFactorEnrolment } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isLibraryFailure } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import type { PlainKey } from '../../../i18n/types';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { useToast } from '../../../ui/toast';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { useContentPorts } from '../../content/content-ports';
import { PASSWORD_FIELD_MAX } from '../../password/password-rules';
import { SettingsCard, SettingsRow } from '../page';
import { TwoFactorQr } from './two-factor-qr';

/** The code's field: six digits, with room for the spaces some apps show and a paste carries, taken out. */
const CODE_FIELD_MAX = 16;

/** What the password is asked for. */
type Purpose = 'start' | 'stop' | 'codes';

type Step =
  | { readonly kind: 'idle' }
  | { readonly kind: 'password'; readonly purpose: Purpose }
  | { readonly kind: 'scan'; readonly enrolment: TwoFactorEnrolment }
  | { readonly kind: 'codes'; readonly codes: readonly string[]; readonly turnedOn: boolean };

type Said =
  | { readonly field: 'password' | 'code' | 'form'; readonly key: PlainKey }
  /** Too many tries: the minutes `Retry-After` asked for. */
  | { readonly field: 'form'; readonly minutes: number };

const HINTS: Readonly<Record<Purpose, PlainKey>> = {
  start: 'settings.account.twoFactor.startHint',
  stop: 'settings.account.twoFactor.stopHint',
  codes: 'settings.account.twoFactor.newCodesHint',
};

const refusalOf = (caught: unknown): Said => {
  if (!isLibraryFailure(caught)) return { field: 'form', key: 'settings.account.twoFactor.failed' };
  if (caught.status === 429) {
    return { field: 'form', minutes: Math.max(1, Math.ceil((caught.retryAfter ?? 60) / 60)) };
  }
  if (caught.code === 'INVALID_PASSWORD') {
    return { field: 'password', key: 'settings.account.twoFactor.wrongPassword' };
  }
  if (caught.code === 'INVALID_CODE') {
    return { field: 'code', key: 'settings.account.twoFactor.wrongCode' };
  }
  if (caught.code === 'NETWORK') {
    return { field: 'form', key: 'settings.account.twoFactor.unreachable' };
  }
  return { field: 'form', key: 'settings.account.twoFactor.failed' };
};

/** The key an `otpauth://` link carries, in groups of four, as an app's "enter a key" screen takes it. */
const keyOf = (totpURI: string): string =>
  (new URL(totpURI).searchParams.get('secret') ?? '').replace(/(.{4})(?=.)/g, '$1 ');

export const TwoFactorCard = ({
  email,
  enabled,
}: {
  /** The account's address, for a password manager to file the password under. */
  readonly email: string;
  readonly enabled: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const { copy } = useContentPorts();
  const { show } = useToast();
  const formId = useId();
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [done, setDone] = useState<PlainKey | null>(null);

  const sentence = (one: Said): string =>
    'minutes' in one ? t('settings.account.twoFactor.tooMany', { count: one.minutes }) : t(one.key);
  const words = (about: Said['field']): { error: string } | Record<string, never> =>
    said?.field === about ? { error: sentence(said) } : {};

  const go = (next: Step): void => {
    setStep(next);
    setPassword('');
    setCode('');
    setSaid(null);
  };

  /** One request at a time, its refusal said where it belongs. */
  const attempt = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setSaid(null);
    try {
      await work();
    } catch (caught) {
      setSaid(refusalOf(caught));
    } finally {
      setBusy(false);
    }
  };

  const reread = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: keys.mySignIn });
  };

  const withPassword = async (purpose: Purpose): Promise<void> => {
    await attempt(async () => {
      if (purpose === 'start') {
        go({ kind: 'scan', enrolment: await api.startTwoFactor(password) });
      } else if (purpose === 'codes') {
        const { backupCodes } = await api.newBackupCodes(password);
        go({ kind: 'codes', codes: backupCodes, turnedOn: false });
      } else {
        await api.stopTwoFactor(password);
        go({ kind: 'idle' });
        setDone('settings.account.twoFactor.offNow');
        await reread();
      }
    });
  };

  const confirm = async (enrolment: TwoFactorEnrolment): Promise<void> => {
    await attempt(async () => {
      await api.confirmTwoFactor(code.replace(/\s+/g, ''));
      go({ kind: 'codes', codes: enrolment.backupCodes, turnedOn: true });
      await reread();
    });
  };

  const copyCodes = (codes: readonly string[]): void => {
    copy(codes.join('\n')).then(
      () => {
        show({ message: t('common.copied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };

  const cancel = (
    <Button
      variant="ghost"
      disabled={busy}
      onClick={() => {
        go({ kind: 'idle' });
      }}
    >
      {t('common.cancel')}
    </Button>
  );

  const formProblem =
    said?.field === 'form' ? (
      <p role="alert" className="text-label text-danger-text">
        {sentence(said)}
      </p>
    ) : null;

  const body = ((): React.ReactNode => {
    if (step.kind === 'password') {
      return (
        <form
          id={formId}
          aria-label={t('settings.account.twoFactor.title')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void withPassword(step.purpose);
          }}
          className="flex max-w-field flex-col gap-4 px-6 py-5 max-narrow:max-w-none max-narrow:px-4 max-narrow:py-4"
        >
          <p className="text-body text-ink-muted">{t(HINTS[step.purpose])}</p>
          {/* Names the account for a password manager, which offers the password filed under it. */}
          <VisuallyHidden asChild>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={email}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
          </VisuallyHidden>
          <TextField
            label={t('settings.account.twoFactor.password')}
            type="password"
            value={password}
            autoComplete="current-password"
            spellCheck={false}
            maxLength={PASSWORD_FIELD_MAX}
            // The field is what the step is for: it takes the focus as it opens.
            autoFocus
            {...words('password')}
            onChange={(event) => {
              setPassword(event.target.value);
              setSaid(null);
            }}
          />
          {formProblem}
        </form>
      );
    }
    if (step.kind === 'scan') {
      const { enrolment } = step;
      return (
        <form
          id={formId}
          aria-label={t('settings.account.twoFactor.title')}
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void confirm(enrolment);
          }}
          className="flex flex-col gap-4 px-6 py-5 max-narrow:px-4 max-narrow:py-4"
        >
          <p className="text-body text-ink">{t('settings.account.twoFactor.scan')}</p>
          <div className="flex flex-wrap items-start gap-6">
            <TwoFactorQr value={enrolment.totpURI} label={t('settings.account.twoFactor.qr')} />
            <dl className="flex min-w-0 flex-col gap-1">
              <dt className="text-label text-ink-muted">{t('settings.account.twoFactor.key')}</dt>
              <dd className="font-mono text-body break-all text-ink select-all">
                {keyOf(enrolment.totpURI)}
              </dd>
              <dd>
                <a href={enrolment.totpURI} className="text-label text-accent-text underline">
                  {t('settings.account.twoFactor.link')}
                </a>
              </dd>
            </dl>
          </div>
          <div className="max-w-field max-narrow:max-w-none">
            <TextField
              label={t('settings.account.twoFactor.code')}
              value={code}
              inputMode="numeric"
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={CODE_FIELD_MAX}
              {...words('code')}
              onChange={(event) => {
                setCode(event.target.value);
                setSaid(null);
              }}
            />
          </div>
          {formProblem}
        </form>
      );
    }
    if (step.kind === 'codes') {
      return (
        <section
          aria-label={t('settings.account.twoFactor.codesTitle')}
          className="flex flex-col gap-4 px-6 py-5 max-narrow:px-4 max-narrow:py-4"
        >
          {step.turnedOn && (
            <p role="status" className="text-label text-success-text">
              {t('settings.account.twoFactor.onNow')}
            </p>
          )}
          <p className="text-body text-ink">{t('settings.account.twoFactor.codesHint')}</p>
          <ul className="grid max-w-field grid-cols-2 gap-2 font-mono text-body text-ink max-narrow:max-w-none">
            {step.codes.map((one) => (
              <li key={one}>{one}</li>
            ))}
          </ul>
        </section>
      );
    }
    return (
      <SettingsRow
        label={t('settings.account.twoFactor.status')}
        description={t('settings.account.twoFactor.otherWays')}
      >
        <span className="text-label text-ink">
          {t(enabled ? 'settings.account.twoFactor.on' : 'settings.account.twoFactor.off')}
        </span>
      </SettingsRow>
    );
  })();

  const footer = ((): React.ReactNode => {
    if (step.kind === 'password' || step.kind === 'scan') {
      return (
        <>
          {cancel}
          <Button variant="primary" busy={busy} type="submit" form={formId}>
            {t(
              step.kind === 'scan'
                ? 'settings.account.twoFactor.confirm'
                : 'settings.account.twoFactor.continue',
            )}
          </Button>
        </>
      );
    }
    if (step.kind === 'codes') {
      const { codes, turnedOn } = step;
      return (
        <>
          <Button
            glyph="copy"
            onClick={() => {
              copyCodes(codes);
            }}
          >
            {t('settings.account.twoFactor.copyCodes')}
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              go({ kind: 'idle' });
              setDone(turnedOn ? 'settings.account.twoFactor.onNow' : null);
            }}
          >
            {t('settings.account.twoFactor.done')}
          </Button>
        </>
      );
    }
    const open = (purpose: Purpose): void => {
      setDone(null);
      go({ kind: 'password', purpose });
    };
    return (
      <>
        {done !== null && (
          <p role="status" className="mr-auto text-label text-success-text">
            {t(done)}
          </p>
        )}
        {enabled ? (
          <>
            <Button
              onClick={() => {
                open('codes');
              }}
            >
              {t('settings.account.twoFactor.newCodes')}
            </Button>
            <Button
              variant="dangerQuiet"
              onClick={() => {
                open('stop');
              }}
            >
              {t('settings.account.twoFactor.stop')}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={() => {
              open('start');
            }}
          >
            {t('settings.account.twoFactor.start')}
          </Button>
        )}
      </>
    );
  })();

  return (
    <SettingsCard
      title={t('settings.account.twoFactor.title')}
      description={t('settings.account.twoFactor.description')}
      footer={footer}
    >
      {body}
    </SettingsCard>
  );
};
