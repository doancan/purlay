/**
 * Step 1: the setup code (UX §11). The address the page is at is compared with the one the server is
 * configured for **before** anything is sent — a code from another origin is refused as cross-site, and
 * a person told "wrong code" for that would retype a right one for ever.
 */
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { Actions, CopyField, FailureNote, Note, StepHeader } from '../parts';

/** Where the operator reads the code (`docker compose logs api`, D-179 §4.1). */
const LOG_COMMAND = 'docker compose logs api | grep -i setup';

/** The origin of an address, or the address itself when it is not one. */
const originOf = (address: string): string => {
  try {
    return new URL(address).origin;
  } catch {
    return address;
  }
};

type Refusal =
  | { readonly kind: 'wrong' }
  | { readonly kind: 'locked'; readonly minutes: number }
  | { readonly kind: 'limited'; readonly minutes: number }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'other'; readonly failure: unknown };

const minutesOf = (seconds: number | null): number => Math.max(1, Math.ceil((seconds ?? 60) / 60));

export const ClaimStep = ({
  appUrl,
  origin = window.location.origin,
  lost,
}: {
  readonly appUrl: string;
  readonly origin?: string;
  /** The claim this browser held is gone: say so above the form. */
  readonly lost: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { client, refresh } = useSetup();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const mismatch = originOf(appUrl) !== origin;

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setRefusal(null);
    try {
      await client.claim(code.trim());
      await refresh();
    } catch (failure) {
      setRefusal(refusalOf(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <StepHeader title={t('setup.claim.title')} lede={t('setup.claim.lede')} />
      {lost && <Note tone="warn">{t('setup.lost')}</Note>}
      {mismatch ? (
        <section className="flex flex-col gap-3">
          <Note tone="warn">
            <strong className="font-medium">{t('setup.mismatch.title')}.</strong>{' '}
            {t('setup.mismatch.body', { address: appUrl, origin })}
          </Note>
          <div>
            <a
              href={`${appUrl.replace(/\/+$/, '')}/setup`}
              className="inline-flex h-control items-center rounded-md border-hairline border-accent bg-accent px-3 text-label text-on-accent hover:bg-accent-hover max-narrow:h-touch"
            >
              {t('setup.mismatch.action', { address: appUrl })}
            </a>
          </div>
        </section>
      ) : refusal?.kind === 'unavailable' ? (
        <section className="flex flex-col gap-2" role="alert">
          <h2 className="text-title">{t('setup.claim.unavailable.title')}</h2>
          <p className="max-w-dialog text-body text-ink-muted">
            {t('setup.claim.unavailable.body')}
          </p>
        </section>
      ) : (
        <form
          onSubmit={(event) => {
            void submit(event);
          }}
          className="flex max-w-dialog flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <p className="text-body text-ink">{t('setup.claim.where')}</p>
            <CopyField label={t('setup.claim.command')} value={LOG_COMMAND} />
            <p className="text-caption text-ink-muted">{t('setup.claim.hour')}</p>
          </div>
          <TextField
            label={t('setup.claim.label')}
            value={code}
            required
            maxLength={64}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="font-mono"
            {...(refusal?.kind === 'wrong' ? { error: t('setup.claim.wrong') } : {})}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
          {refusal?.kind === 'locked' && (
            <Note tone="warn">{t('setup.claim.locked', { count: refusal.minutes })}</Note>
          )}
          {refusal?.kind === 'limited' && (
            <Note tone="warn">{t('setup.claim.limited', { count: refusal.minutes })}</Note>
          )}
          {refusal?.kind === 'forbidden' && (
            <Note tone="warn">{t('setup.claim.forbidden', { address: appUrl })}</Note>
          )}
          {refusal?.kind === 'other' && <FailureNote failure={refusal.failure} />}
          <p className="text-caption text-ink-muted">{t('setup.claim.takeover')}</p>
          <Actions>
            <Button type="submit" variant="primary" busy={busy} disabled={code.trim() === ''}>
              {t('setup.continue')}
            </Button>
          </Actions>
        </form>
      )}
    </div>
  );
};

/** What a refused claim means, from the server's answer. */
const refusalOf = (failure: unknown): Refusal => {
  if (!isSetupFailure(failure)) return { kind: 'other', failure };
  if (failure.code === 'VALIDATION_FAILED') return { kind: 'wrong' };
  if (failure.code === 'SETUP_LOCKED') {
    return { kind: 'locked', minutes: minutesOf(failure.retryAfter) };
  }
  if (failure.code === 'RATE_LIMITED') {
    return { kind: 'limited', minutes: minutesOf(failure.retryAfter) };
  }
  if (failure.code === 'SETUP_UNAVAILABLE') return { kind: 'unavailable' };
  if (failure.code === 'FORBIDDEN') return { kind: 'forbidden' };
  return { kind: 'other', failure };
};
