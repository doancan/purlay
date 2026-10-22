/**
 * Change password (D-179 §4), on Sessions & account — only for an account that has one (`hasPassword`:
 * the setup's administrator). The new password is read against the policy as it is typed (`passwordProblem`,
 * `@purlay/types`, the same function the server runs); the server says it again, by rule name. A success
 * ends every other session of the person — the page says so — and keeps this one. A wrong current
 * password is one sentence; a wait is told in minutes.
 */
import { passwordProblem, type PasswordProblem } from '@purlay/types';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isLibraryFailure } from '../../../data/errors';
import { useI18n } from '../../../i18n/i18n-provider';
import type { PlainKey } from '../../../i18n/types';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { VisuallyHidden } from '../../../ui/visually-hidden';
import { PASSWORD_PROBLEMS, PasswordRules } from '../../password/password-rules';
import { useSession } from '../../session/session';
import { SettingsCard } from '../page';

type Said =
  | { readonly field: 'current' | 'next' | 'form'; readonly key: PlainKey }
  /** Too many tries: the minutes `Retry-After` asked for. */
  | { readonly field: 'form'; readonly minutes: number };

/** The library's own codes for a length it refuses, by the policy's names. */
const LENGTH_CODES: Readonly<Record<string, PasswordProblem>> = {
  PASSWORD_TOO_SHORT: 'too-short',
  PASSWORD_TOO_LONG: 'too-long',
};

const isProblem = (word: string | null): word is PasswordProblem =>
  word !== null && Object.hasOwn(PASSWORD_PROBLEMS, word);

const refusalOf = (caught: unknown): Said => {
  if (!isLibraryFailure(caught)) return { field: 'form', key: 'settings.account.password.failed' };
  if (caught.status === 429) {
    return { field: 'form', minutes: Math.max(1, Math.ceil((caught.retryAfter ?? 60) / 60)) };
  }
  if (caught.code === 'OTHER_SESSIONS_NOT_ENDED') {
    return { field: 'form', key: 'settings.account.password.othersStay' };
  }
  if (caught.code === 'INVALID_PASSWORD') {
    return { field: 'current', key: 'settings.account.password.wrong' };
  }
  const length = LENGTH_CODES[caught.code];
  if (length !== undefined) return { field: 'next', key: PASSWORD_PROBLEMS[length] };
  if (caught.code === 'PASSWORD_TOO_WEAK' && isProblem(caught.reason)) {
    return { field: 'next', key: PASSWORD_PROBLEMS[caught.reason] };
  }
  if (caught.code === 'NETWORK') {
    return { field: 'form', key: 'settings.account.password.unreachable' };
  }
  return { field: 'form', key: 'settings.account.password.failed' };
};

export const ChangePasswordCard = ({ email }: { readonly email: string }): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { user } = useSession();
  const formId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  const [done, setDone] = useState(false);

  const problem = passwordProblem(next, { email, name: user.displayName });
  const sentence = (one: Said): string =>
    'minutes' in one ? t('settings.account.password.tooMany', { count: one.minutes }) : t(one.key);
  const words = (about: Said['field']): { error: string } | Record<string, never> =>
    said?.field === about ? { error: sentence(said) } : {};

  const submit = async (): Promise<void> => {
    setDone(false);
    if (problem !== undefined) {
      setSaid({ field: 'next', key: PASSWORD_PROBLEMS[problem] });
      return;
    }
    setBusy(true);
    setSaid(null);
    try {
      await api.changePassword({ currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setDone(true);
    } catch (caught) {
      // The password did change, whatever the other sessions' fate: the fields are not kept.
      if (isLibraryFailure(caught) && caught.code === 'OTHER_SESSIONS_NOT_ENDED') {
        setCurrent('');
        setNext('');
      }
      setSaid(refusalOf(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={t('settings.account.password.title')}
      description={t('settings.account.password.description')}
      footer={
        <>
          {done && (
            <p role="status" className="mr-auto text-label text-success-text">
              {t('settings.account.password.done')}
            </p>
          )}
          {/* In the card's footer, outside the form: `form` joins it, so Enter in a field presses it. */}
          <Button variant="primary" busy={busy} type="submit" form={formId}>
            {t('settings.account.password.submit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        aria-label={t('settings.account.password.title')}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex max-w-field flex-col gap-4 px-6 py-5 max-narrow:max-w-none max-narrow:px-4 max-narrow:py-4"
      >
        {/* Names the account for a password manager, which files the new password under it. */}
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
          label={t('settings.account.password.current')}
          type="password"
          value={current}
          autoComplete="current-password"
          spellCheck={false}
          maxLength={256}
          {...words('current')}
          onChange={(event) => {
            setCurrent(event.target.value);
            setSaid(null);
          }}
        />
        <TextField
          label={t('settings.account.password.new')}
          type="password"
          value={next}
          autoComplete="new-password"
          spellCheck={false}
          maxLength={256}
          {...words('next')}
          onChange={(event) => {
            setNext(event.target.value);
            setSaid(null);
            setDone(false);
          }}
        />
        <PasswordRules password={next} problem={problem} />
        {said?.field === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {sentence(said)}
          </p>
        )}
      </form>
    </SettingsCard>
  );
};
