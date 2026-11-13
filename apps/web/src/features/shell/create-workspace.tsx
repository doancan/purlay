/** The workspace creation form, loaded only when someone asks to make a workspace. */
import { WORKSPACE_NAME_MAX, WORKSPACE_SLUG_MAX } from '@purlay/types';
import { useState } from 'react';
import { useDescribeFailure } from '../../data/failure';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { TextField } from '../../ui/text-field';
import { SLUG, slugOf } from './workspace-slug';

export interface CreateWorkspaceProps {
  /** In a dialog, which says what it is for: the form is drawn without its own heading. */
  readonly framed?: boolean;
  /** Made: the dialog closes. The page goes to the new workspace either way. */
  readonly onCreated?: () => void;
  /** In a dialog: Cancel beside the submit, at the right, as every other dialog's footer is. */
  readonly onCancel?: () => void;
}

export const CreateWorkspace = ({
  framed = true,
  onCreated,
  onCancel,
}: CreateWorkspaceProps): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { createWorkspace } = useActions();
  const { navigate } = useRoute();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [edited, setEdited] = useState(false);
  const [error, setError] = useState<{ field: 'name' | 'slug' | 'form'; message: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const address = edited ? slug : slugOf(name);

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!SLUG.test(address)) {
      setError({ field: 'slug', message: t('workspace.create.invalid') });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const workspace = await createWorkspace({ name: name.trim(), slug: address });
      onCreated?.();
      // From `/`, which only ever redirects, Back must not return there; from a workspace it may.
      navigate(href('workspace', { slug: workspace.slug }), { replace: framed });
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.code === 'FORBIDDEN') {
        // The server's rule moved under the form — the first workspace made a moment ago (D-155).
        setError({ field: 'form', message: t('workspace.create.notAllowed') });
      } else if (isApiError(failure) && failure.code === 'WORKSPACE_SLUG_TAKEN') {
        setError({ field: 'slug', message: t('workspace.create.taken') });
      } else if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        // Said under the field the server named: a refused name is not an address problem.
        setError(
          'name' in failure.fields
            ? { field: 'name', message: t('workspace.nameInvalid', { max: WORKSPACE_NAME_MAX }) }
            : { field: 'slug', message: t('workspace.create.invalid') },
        );
      } else {
        setError({
          field: 'form',
          message: `${t('workspace.create.failed')} ${describe(failure)}`,
        });
      }
    }
  };

  return (
    <form
      onSubmit={(event) => {
        void submit(event);
      }}
      className={
        framed
          ? 'flex flex-col gap-4 border-t-hairline border-border-subtle pt-6'
          : 'flex flex-col gap-4'
      }
    >
      {framed && (
        <>
          <h2 className="text-title text-ink">{t('workspace.create.title')}</h2>
          <p className="text-body text-ink-muted">{t('workspace.create.body')}</p>
        </>
      )}
      <TextField
        label={t('workspace.create.name')}
        value={name}
        required
        maxLength={WORKSPACE_NAME_MAX}
        {...(error?.field === 'name' ? { error: error.message } : {})}
        autoComplete="off"
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <TextField
        label={t('workspace.create.slug')}
        hint={t('workspace.create.slugHint')}
        value={address}
        required
        maxLength={WORKSPACE_SLUG_MAX}
        autoComplete="off"
        spellCheck={false}
        {...(error?.field === 'slug' ? { error: error.message } : {})}
        onChange={(event) => {
          setEdited(true);
          setSlug(event.target.value);
        }}
      />
      {error?.field === 'form' && (
        <p role="alert" className="text-label text-danger-text">
          {error.message}
        </p>
      )}
      <div className={cn(onCancel !== undefined && 'flex justify-end gap-2')}>
        {onCancel !== undefined && <Button onClick={onCancel}>{t('common.cancel')}</Button>}
        <Button type="submit" variant="primary" busy={busy}>
          {t('workspace.create.submit')}
        </Button>
      </div>
    </form>
  );
};
