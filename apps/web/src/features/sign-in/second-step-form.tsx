/**
 * The second step of a password sign-in (D-236): the password was right and the account asks for a code — from
 * the authenticator app, or one of the backup codes. Nothing is signed in until the code is right.
 *
 * A wrong code is one sentence and the field again. A challenge that is over — ten minutes passed, or five wrong
 * codes spent it — sends the person back to the password with a sentence that says so (`onRestart`). Too many
 * wrong codes in a row lock the step; the wait is told in minutes.
 */
import { TWO_FACTOR_CODE_DIGITS, TWO_FACTOR_LOCK_MINUTES } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isLibraryFailure } from '../../data/errors';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { TextField } from '../../ui/text-field';

/**
 * What either field takes: a backup code is ten letters and digits in two halves, an app's code six digits that
 * some apps show in two groups; room for the spaces a person or a paste puts in, which are taken out.
 */
const CODE_FIELD_MAX = 32;

/** The library's answers that mean this challenge is over: the password is asked again. */
const CHALLENGE_OVER: ReadonlySet<string> = new Set([
  'INVALID_TWO_FACTOR_COOKIE',
  'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE',
]);

interface SecondStepFormProps {
  /** Back to the password: with a sentence when the challenge ended by itself, without one when asked. */
  readonly onRestart: (said: string | null) => void;
  readonly className?: string;
}

export const SecondStepForm = ({
  onRestart,
  className,
}: SecondStepFormProps): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const [kind, setKind] = useState<'app' | 'backup'>('app');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  // The field is where the person is wanted, when the step opens and when the kind of code changes.
  useEffect(() => {
    field.current?.focus();
  }, [kind]);

  const refusal = (caught: unknown): string => {
    if (!isLibraryFailure(caught)) return t('signIn.password.failed');
    if (caught.code === 'INVALID_CODE' || caught.code === 'INVALID_BACKUP_CODE') {
      return t('signIn.code.wrong');
    }
    if (caught.code === 'ACCOUNT_TEMPORARILY_LOCKED') {
      return t('signIn.code.locked', { count: TWO_FACTOR_LOCK_MINUTES });
    }
    if (caught.status === 429) {
      return t('signIn.password.tooMany', {
        count: Math.max(1, Math.ceil((caught.retryAfter ?? 60) / 60)),
      });
    }
    if (caught.code === 'NETWORK') return t('signIn.password.unreachable');
    return t('signIn.password.failed');
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    setSaid(null);
    try {
      await api.verifySignInCode({ code: code.replace(/\s+/g, ''), kind });
      // The session is there now: the screen asks who it is, and a person who has one is sent on.
      await client.invalidateQueries({ queryKey: keys.me });
    } catch (caught) {
      setBusy(false);
      if (isLibraryFailure(caught) && CHALLENGE_OVER.has(caught.code)) {
        onRestart(t('signIn.code.expired'));
        return;
      }
      setSaid(refusal(caught));
      setCode('');
      field.current?.focus();
    }
  };

  return (
    <form
      aria-label={t('signIn.code.form')}
      onSubmit={(event) => {
        event.preventDefault();
        void verify();
      }}
      className={className}
    >
      <p className="text-body text-ink">
        {kind === 'app'
          ? t('signIn.code.appHint', { digits: TWO_FACTOR_CODE_DIGITS })
          : t('signIn.code.backupHint')}
      </p>
      <TextField
        ref={field}
        label={t(kind === 'app' ? 'signIn.code.appLabel' : 'signIn.code.backupLabel')}
        value={code}
        required
        // The app's code is digits, and the phone's own suggestion of one is welcome; a backup code is not.
        {...(kind === 'app'
          ? { inputMode: 'numeric' as const, autoComplete: 'one-time-code' }
          : { autoComplete: 'off' })}
        maxLength={CODE_FIELD_MAX}
        spellCheck={false}
        {...(said === null ? {} : { error: said })}
        onChange={(event) => {
          setCode(event.target.value);
        }}
      />
      <Button type="submit" variant="primary" busy={busy} className="w-full">
        {t('signIn.code.submit')}
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={busy}
        onClick={() => {
          setKind(kind === 'app' ? 'backup' : 'app');
          setCode('');
          setSaid(null);
        }}
      >
        {t(kind === 'app' ? 'signIn.code.useBackup' : 'signIn.code.useApp')}
      </Button>
      <Button
        variant="ghost"
        className="w-full"
        disabled={busy}
        onClick={() => {
          onRestart(null);
        }}
      >
        {t('signIn.code.restart')}
      </Button>
    </form>
  );
};
