/**
 * Step 6: the first workspace (UX §11, D-124): a name, and the address its people open, which follows
 * the name until it is edited — the same form's rule as *Create workspace* on the front page. The API
 * has no availability question, so a taken address is said when it is submitted.
 */
import { WORKSPACE_NAME_MAX, WORKSPACE_SLUG_MAX } from '@purlay/types';
import { useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { TextField } from '../../../ui/text-field';
import { SLUG, slugOf } from '../../shell/home';
import { isSetupFailure } from '../client';
import { useSetup } from '../context';
import { Actions, FailureNote, Note, StepHeader } from '../parts';
import type { StepProps } from './props';

export const WorkspaceStep = ({ state, onBack, onNext }: StepProps): React.JSX.Element => {
  const { t } = useI18n();
  const { client, refresh, lose } = useSetup();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [edited, setEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{
    readonly field: 'name' | 'slug';
    readonly message: string;
  } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const address = edited ? slug : slugOf(name);
  const urlOf = (value: string): string => `${window.location.origin}/w/${value}`;
  const back =
    onBack === null ? null : (
      <Button variant="ghost" onClick={onBack}>
        {t('setup.back')}
      </Button>
    );

  if (state.workspace !== null) {
    return (
      <div className="flex flex-col gap-6">
        <StepHeader title={t('setup.workspace.title')} lede={t('setup.workspace.lede')} />
        <Note tone="good">
          {t('setup.workspace.done', {
            name: state.workspace.name,
            url: urlOf(state.workspace.slug),
          })}
        </Note>
        <Actions start={back}>
          <Button variant="primary" onClick={onNext}>
            {t('setup.continue')}
          </Button>
        </Actions>
      </div>
    );
  }

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    setFailure(null);
    if (name.trim() === '') {
      setError({ field: 'name', message: t('setup.admin.nameBlank') });
      return;
    }
    if (!SLUG.test(address)) {
      setError({ field: 'slug', message: t('workspace.create.invalid') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await client.workspace({ name: name.trim(), slug: address });
      await refresh();
    } catch (caught) {
      if (isSetupFailure(caught) && caught.code === 'WORKSPACE_SLUG_TAKEN') {
        setError({ field: 'slug', message: t('workspace.create.taken') });
      } else if (isSetupFailure(caught) && caught.code === 'VALIDATION_FAILED') {
        setError({ field: 'slug', message: t('workspace.create.invalid') });
      } else {
        setFailure(caught);
        if (isSetupFailure(caught) && caught.code === 'SETUP_UNAVAILABLE') lose();
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      noValidate
      className="flex flex-col gap-6"
    >
      <StepHeader title={t('setup.workspace.title')} lede={t('setup.workspace.lede')} />
      <div className="flex max-w-dialog flex-col gap-4">
        <TextField
          label={t('workspace.create.name')}
          value={name}
          maxLength={WORKSPACE_NAME_MAX}
          autoComplete="off"
          {...(error?.field === 'name' ? { error: error.message } : {})}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <TextField
          label={t('workspace.create.slug')}
          value={address}
          maxLength={WORKSPACE_SLUG_MAX}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          hint={
            address === ''
              ? t('workspace.create.slugHint')
              : t('setup.workspace.preview', { url: urlOf(address) })
          }
          {...(error?.field === 'slug' ? { error: error.message } : {})}
          onChange={(event) => {
            setSlug(event.target.value.toLowerCase());
            setEdited(true);
          }}
        />
        {failure !== null && <FailureNote failure={failure} />}
      </div>
      <Actions start={back}>
        <Button type="submit" variant="primary" busy={busy}>
          {t('workspace.create.submit')}
        </Button>
      </Actions>
    </form>
  );
};
