/**
 * The workspaces this person owns whose deletion was asked for (D-242): one bar each, saying when its
 * content goes, with the way to keep it. A workspace being deleted is gone from everybody's sidebar —
 * nobody can use it — so this bar, beside the connection's, and on the front door when nothing else is
 * left, is the one place an owner meets it again. The list is `GET /api/me`'s, read again whenever a member's
 * socket hears `WORKSPACE_UPDATED`; kept, it is read again here at once and the workspace is back.
 */
import type { WorkspaceDeletion } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Icon } from '../../components/icon';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { useSession } from '../session/session';

const ScheduledDeletion = ({
  deletion,
}: {
  readonly deletion: WorkspaceDeletion;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const keep = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api.cancelWorkspaceDeletion(deletion.workspace.id);
      await client.invalidateQueries({ queryKey: keys.me });
    } catch (failure) {
      setProblem(`${t('scheduledDeletion.failed')} ${describe(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-danger-subtle px-4 py-1 text-label text-danger-text">
      <Icon name="delete" size="sm" />
      <span>
        {t('scheduledDeletion.notice', {
          workspace: deletion.workspace.name,
          when: format.absolute(deletion.purgeAt),
        })}
      </span>
      <button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => {
          void keep();
        }}
        className="underline"
      >
        {t('scheduledDeletion.keep', { workspace: deletion.workspace.name })}
      </button>
      {problem !== null && <span role="alert">{problem}</span>}
    </div>
  );
};

export const ScheduledDeletions = (): React.JSX.Element | null => {
  const { t } = useI18n();
  const { scheduledDeletions } = useSession();
  if (scheduledDeletions.length === 0) return null;
  return (
    <section aria-label={t('scheduledDeletion.region')} className="flex shrink-0 flex-col">
      {scheduledDeletions.map((deletion) => (
        <ScheduledDeletion key={deletion.workspace.id} deletion={deletion} />
      ))}
    </section>
  );
};
