/**
 * Erasing one's own account (D-27 §2, D-139 §5): what goes, what stays for the team, and that it cannot
 * be undone — then the username, typed, before the button does anything. Each refusal is said where it
 * belongs: a username that is not theirs under the field; a session too old, with the way to a fresh
 * one; the workspaces they are the last live owner of, by name, to hand over first (§6).
 *
 * Done, the page forgets them as signing out does, and the sign-in screen says the account is gone.
 */
import { useId, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { TextField } from '../../ui/text-field';
import { useSession } from '../session/session';

type Problem =
  | { readonly kind: 'field'; readonly message: string }
  | { readonly kind: 'stale' }
  | { readonly kind: 'form'; readonly message: string };

export const EraseAccountDialog = ({
  open,
  onOpenChange,
  onSignOut,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The way to a fresh sign-in, when the session is too old for this. */
  readonly onSignOut: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { user, memberships } = useSession();
  const { eraseAccount } = useActions();
  const { navigate } = useRoute();
  const describe = useDescribeFailure();
  const formId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  const change = (next: boolean): void => {
    if (!next) {
      setTyped('');
      setProblem(null);
    }
    onOpenChange(next);
  };

  const erase = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (typed !== user.username) {
      setProblem({ kind: 'field', message: t('erase.mismatch') });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await eraseAccount(typed);
      navigate(`${href('signIn')}?reason=erased`, { replace: true });
    } catch (failure) {
      setBusy(false);
      if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') {
        setProblem({ kind: 'field', message: t('erase.mismatch') });
      } else if (isApiError(failure) && failure.code === 'REAUTHENTICATION_REQUIRED') {
        setProblem({ kind: 'stale' });
      } else if (isApiError(failure) && failure.code === 'LAST_OWNER') {
        const names = memberships
          .filter((membership) => failure.workspaceIds.includes(membership.workspace.id))
          .map((membership) => membership.workspace.name);
        setProblem({
          kind: 'form',
          message: t('erase.lastOwner', { workspaces: names.join(', ') }),
        });
      } else {
        setProblem({ kind: 'form', message: `${t('erase.failed')} ${describe(failure)}` });
      }
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('erase.title')}
      description={t('erase.body')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              change(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="danger"
            busy={busy}
            disabled={typed !== user.username}
          >
            {t('erase.submit')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          void erase(event);
        }}
        className="flex flex-col gap-3"
      >
        <TextField
          label={t('erase.confirm', { username: user.username })}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          {...(problem?.kind === 'field' ? { error: problem.message } : {})}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
        {problem?.kind === 'stale' && (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-label text-danger-text">{t('erase.reauthenticate')}</p>
            <Button
              onClick={() => {
                change(false);
                onSignOut();
              }}
            >
              {t('erase.signOut')}
            </Button>
          </div>
        )}
        {problem?.kind === 'form' && (
          <p role="alert" className="text-label text-danger-text">
            {problem.message}
          </p>
        )}
      </form>
    </Dialog>
  );
};
