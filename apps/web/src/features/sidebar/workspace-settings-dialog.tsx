/**
 * Workspace settings, an owner's or an admin's (D-124): the workspace's name. The address — the slug
 * in every link already pasted — is shown and does not change, so the dialog says so rather than
 * leaving somebody to find out.
 *
 * Saved, the name is everywhere in this tab at once (the server's answer goes into the session), and
 * every other tab of every member hears `WORKSPACE_UPDATED` and reads it again. What the server
 * refuses comes back under the field, and what was typed stays for a retry.
 */
import { WORKSPACE_NAME_MAX } from '@purlay/types';
import { useId, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useWorkspace } from '../shell/workspace';

export const WorkspaceSettingsDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const { renameWorkspace } = useActions();
  const formId = useId();
  const [name, setName] = useState(workspace.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Each opening starts from the name as it is now — another tab may have changed it since.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(workspace.name);
      setProblem(null);
      setBusy(false);
    }
  }

  const submit = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    const wanted = name.trim();
    if (wanted === '') {
      setProblem(t('workspace.settings.empty'));
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await renameWorkspace(workspace.id, wanted);
      onOpenChange(false);
    } catch (failure) {
      setBusy(false);
      setProblem(
        isApiError(failure) && failure.code === 'VALIDATION_FAILED'
          ? t('workspace.settings.invalid', { max: WORKSPACE_NAME_MAX })
          : `${t('workspace.settings.failed')} ${describe(failure)}`,
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('workspace.settings.title')}
      description={t('workspace.settings.description', { slug: workspace.slug })}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary" busy={busy}>
            {t('workspace.settings.save')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <TextField
          label={t('workspace.create.name')}
          value={name}
          maxLength={WORKSPACE_NAME_MAX}
          required
          autoComplete="off"
          {...(problem === null ? {} : { error: problem })}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
};
