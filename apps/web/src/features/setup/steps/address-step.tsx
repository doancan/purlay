/**
 * Step 3: the server's address and who may sign up (UX §11, Ruling R35). The address is shown, never
 * edited — it is `APP_URL`, a deployment setting — and the one choice is the sign-up policy, with its
 * consequence in a sentence, the safer one already chosen.
 */
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { Actions, CopyField, FailureNote, StepHeader } from '../parts';
import type { StepProps } from './props';
import { Radio } from '../../../ui/checkbox';

type Policy = 'invite-only' | 'open';

export const AddressStep = ({ state, done, onBack }: StepProps): React.JSX.Element => {
  const { t } = useI18n();
  const { client, refresh, lose } = useSetup();
  // What was chosen if this was done before; otherwise the safer of the two.
  const [policy, setPolicy] = useState<Policy>(done ? state.settings.signUp : 'invite-only');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      await client.confirmAddress();
      await client.policy(policy);
      await refresh();
    } catch (caught) {
      setFailure(caught);
      if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
    } finally {
      setBusy(false);
    }
  };

  const options: readonly {
    readonly value: Policy;
    readonly label: string;
    readonly note: string;
  }[] = [
    { value: 'invite-only', label: t('setup.policy.invite'), note: t('setup.policy.inviteNote') },
    { value: 'open', label: t('setup.policy.open'), note: t('setup.policy.openNote') },
  ];

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className="flex flex-col gap-6"
    >
      <StepHeader title={t('setup.address.title')} lede={t('setup.address.lede')} />
      <div className="flex max-w-dialog flex-col gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-label text-ink">{t('setup.address.label')}</span>
          <CopyField label={t('setup.address.label')} value={state.appUrl} />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-label text-ink">{t('setup.address.callback')}</span>
          <CopyField label={t('setup.address.callback')} value={state.githubCallbackUrl} />
          <p className="text-caption text-ink-muted">{t('setup.address.callbackHint')}</p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="pb-1 text-label text-ink">{t('setup.policy.legend')}</legend>
          {options.map((option) => (
            <label
              key={option.value}
              className={cn(
                'flex cursor-pointer items-start gap-3 rounded-md border-hairline p-3',
                policy === option.value
                  ? 'border-accent bg-accent-subtle'
                  : 'border-border-subtle bg-surface-100 hover:bg-surface-050',
              )}
            >
              <Radio
                name="policy"
                value={option.value}
                checked={policy === option.value}
                onChange={() => {
                  setPolicy(option.value);
                }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="text-label text-ink">{option.label}</span>
                <span className="text-caption text-ink-muted">{option.note}</span>
              </span>
            </label>
          ))}
        </fieldset>
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
          {t('setup.address.submit')}
        </Button>
      </Actions>
    </form>
  );
};
