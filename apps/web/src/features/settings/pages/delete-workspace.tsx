/**
 * Deleting the workspace (D-242), an owner's alone, in General's danger zone: what goes and when, the way
 * to an export first (Data & retention), then the workspace's name, typed, before the button does
 * anything. The server compares the name too; what it refuses is said under the field or above the
 * buttons, and what was typed stays.
 *
 * Asked for, the workspace leaves this tab at once, as it leaves everybody's: the session is read again
 * and the front door takes the person to what is left — where the bar for taking it back waits
 * (`scheduled-deletions.tsx`).
 */
import { WORKSPACE_DELETION_GRACE_DAYS, WORKSPACE_NAME_MAX } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { href } from '../../../router/routes';
import { Link, useRoute } from '../../../router/router-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard, SettingsRow } from '../page';

type Problem =
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'form'; readonly message: string };

export const DeleteWorkspaceCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { navigate } = useRoute();
  const { workspace } = useWorkspace();
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  // One Unicode form, as the server compares: a keyboard that composes `ğ` otherwise types the same name.
  const matches = typed.normalize('NFC') === workspace.name.normalize('NFC');

  const change = (next: boolean): void => {
    if (busy) return;
    if (!next) {
      setTyped('');
      setProblem(null);
    }
    setOpen(next);
  };

  const remove = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!matches) {
      setProblem({ kind: 'field', message: t('deleteWorkspace.mismatch') });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await api.requestWorkspaceDeletion(workspace.id, typed);
    } catch (failure) {
      setBusy(false);
      setProblem(
        isApiError(failure) && failure.code === 'VALIDATION_FAILED'
          ? { kind: 'field', message: t('deleteWorkspace.mismatch') }
          : { kind: 'form', message: `${t('deleteWorkspace.failed')} ${describe(failure)}` },
      );
      return;
    }
    // Gone from this tab as from everybody's: the memberships are read again, and the front door takes
    // the person to what is left.
    await client.invalidateQueries({ queryKey: keys.me });
    navigate(href('home'), { replace: true });
  };

  return (
    <SettingsCard title={t('settings.account.danger')} tone="danger">
      <SettingsRow
        label={t('deleteWorkspace.title', { workspace: workspace.name })}
        description={t('deleteWorkspace.hint', { days: WORKSPACE_DELETION_GRACE_DAYS })}
      >
        <Button
          variant="dangerQuiet"
          // Under the words on a phone, a fill-less button's words line up with them, not its edge.
          className="max-narrow:-ml-3"
          glyph="delete"
          onClick={() => {
            change(true);
          }}
        >
          {t('deleteWorkspace.entry')}
        </Button>
      </SettingsRow>
      <Dialog
        open={open}
        onOpenChange={change}
        title={t('deleteWorkspace.title', { workspace: workspace.name })}
        description={t('deleteWorkspace.body', { days: WORKSPACE_DELETION_GRACE_DAYS })}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                change(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button type="submit" form={formId} variant="danger" busy={busy} disabled={!matches}>
              {t('deleteWorkspace.submit')}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          onSubmit={(event) => {
            void remove(event);
          }}
          className="flex flex-col gap-3"
        >
          <p className="text-body text-ink-muted">
            {t('deleteWorkspace.exportFirst')}{' '}
            <Link
              to="settings"
              params={{ slug: workspace.slug, section: 'data' }}
              className="text-accent-text underline"
            >
              {t('deleteWorkspace.exportLink')}
            </Link>
          </p>
          <TextField
            label={t('deleteWorkspace.confirm', { workspace: workspace.name })}
            value={typed}
            maxLength={WORKSPACE_NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            {...(problem?.kind === 'field' ? { error: problem.message } : {})}
            onChange={(event) => {
              setTyped(event.target.value);
              setProblem(null);
            }}
          />
          {problem?.kind === 'form' && (
            <p role="alert" className="text-label text-danger-text">
              {problem.message}
            </p>
          )}
        </form>
      </Dialog>
    </SettingsCard>
  );
};
