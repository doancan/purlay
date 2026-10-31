/**
 * Step 2: the administrator (UX §11). The password's rules are the policy's (`passwordProblem`,
 * `@purlay/types`): read here as the person types, never written a second time — the hints are what
 * that function says of the password so far, and the server says it again.
 */
import { DISPLAY_NAME_MAX, EMAIL_MAX, passwordProblem, type PasswordProblem } from '@purlay/types';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import {
  PASSWORD_FIELD_MAX,
  PASSWORD_PROBLEMS,
  PasswordRules,
} from '../../password/password-rules';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { Actions, FailureNote, Note, StepHeader, useHeadingFocusOnChange } from '../parts';
import type { StepProps } from './props';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Errors {
  readonly name?: string | undefined;
  readonly email?: string | undefined;
  readonly password?: string | undefined;
}

export const AdminStep = ({ state, onBack, onNext }: StepProps): React.JSX.Element => {
  const { t } = useI18n();
  const { client, refresh, lose } = useSetup();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [notSignedIn, setNotSignedIn] = useState(false);

  const problem = passwordProblem(password, { email, name });

  useHeadingFocusOnChange(notSignedIn ? 'notSignedIn' : state.admin !== null ? 'done' : 'form');

  if (state.admin !== null && !notSignedIn) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeader title={t('setup.admin.title')} lede={t('setup.admin.lede')} />
        <Note tone="good">
          {t('setup.admin.done', { name: state.admin.name, email: state.admin.email })}
        </Note>
        <Actions
          start={
            onBack === null ? null : (
              <Button variant="ghost" onClick={onBack}>
                {t('setup.back')}
              </Button>
            )
          }
        >
          <Button variant="primary" onClick={onNext}>
            {t('setup.continue')}
          </Button>
        </Actions>
      </div>
    );
  }

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const found: { name?: string; email?: string; password?: string } = {};
    if (name.trim() === '') found.name = t('setup.admin.nameBlank');
    if (!EMAIL.test(email.trim())) found.email = t('setup.admin.emailInvalid');
    if (problem !== undefined) found.password = t(PASSWORD_PROBLEMS[problem]);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const made = await client.admin({ name: name.trim(), email: email.trim(), password });
      if (made.signedIn) await refresh();
      else setNotSignedIn(true);
    } catch (caught) {
      if (isSetupFailure(caught) && caught.code === 'VALIDATION_FAILED') {
        const word = caught.fields['password'];
        const rule = (Object.keys(PASSWORD_PROBLEMS) as PasswordProblem[]).find(
          (one) => one === word,
        );
        setErrors({
          ...(caught.fields['name'] === undefined ? {} : { name: t('setup.admin.nameBlank') }),
          ...(caught.fields['email'] === undefined ? {} : { email: t('setup.admin.emailInvalid') }),
          ...(word === undefined
            ? {}
            : {
                password: t(rule === undefined ? 'setup.failed.generic' : PASSWORD_PROBLEMS[rule]),
              }),
        });
      } else if (isSetupFailure(caught) && caught.code === 'ACCOUNT_EMAIL_CONFLICT') {
        setErrors({ email: t('setup.admin.conflict') });
      } else if (isSetupFailure(caught) && caught.refusal === 'admin-exists') {
        await refresh();
      } else {
        setFailure(caught);
        if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
      }
    } finally {
      setBusy(false);
    }
  };

  if (notSignedIn) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeader title={t('setup.admin.title')} lede={t('setup.admin.lede')} />
        <Note tone="warn">{t('setup.admin.notSignedIn')}</Note>
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

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
      className="flex flex-col gap-6"
    >
      <StepHeader title={t('setup.admin.title')} lede={t('setup.admin.lede')} />
      <div className="flex max-w-dialog flex-col gap-4">
        <TextField
          label={t('setup.admin.name')}
          value={name}
          autoComplete="name"
          maxLength={DISPLAY_NAME_MAX}
          {...(errors.name === undefined ? {} : { error: errors.name })}
          onChange={(event) => {
            setName(event.target.value);
            setErrors((now) => ({ ...now, name: undefined }));
          }}
        />
        <TextField
          label={t('setup.admin.email')}
          type="email"
          value={email}
          autoComplete="email"
          spellCheck={false}
          maxLength={EMAIL_MAX}
          {...(errors.email === undefined ? {} : { error: errors.email })}
          onChange={(event) => {
            setEmail(event.target.value);
            setErrors((now) => ({ ...now, email: undefined }));
          }}
        />
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <TextField
                label={t('setup.admin.password')}
                type={reveal ? 'text' : 'password'}
                value={password}
                autoComplete="new-password"
                spellCheck={false}
                maxLength={PASSWORD_FIELD_MAX}
                {...(errors.password === undefined ? {} : { error: errors.password })}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setErrors((now) => ({ ...now, password: undefined }));
                }}
              />
            </div>
            <Button
              variant="ghost"
              className="mt-6 shrink-0"
              aria-pressed={reveal}
              aria-label={reveal ? t('setup.admin.hideLabel') : t('setup.admin.showLabel')}
              onClick={() => {
                setReveal((now) => !now);
              }}
            >
              {reveal ? t('setup.admin.hide') : t('setup.admin.show')}
            </Button>
          </div>
          <PasswordRules password={password} problem={problem} />
        </div>
        <Note>{t('setup.admin.unverified')}</Note>
        {failure !== null && <FailureNote failure={failure} />}
      </div>
      <Actions
        start={
          onBack === null ? null : (
            <Button variant="ghost" onClick={onBack}>
              {t('setup.back')}
            </Button>
          )
        }
      >
        <Button type="submit" variant="primary" busy={busy}>
          {t('setup.admin.submit')}
        </Button>
      </Actions>
    </form>
  );
};
