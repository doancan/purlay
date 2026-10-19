/**
 * An owner's export of the workspace (D-140): asked for here, made by the server in the background, and
 * downloaded once. What the owner can see goes — the public channels and the private ones and direct
 * messages they are in — and nobody's address.
 *
 * The list is the owner's own exports, newest first, read again every few seconds while one is being
 * made. A ready one is a link that works once: following it marks it downloaded here at once, as the
 * server does, so the link is not offered twice. A failed one says why, by its code.
 */
import type { WorkspaceExport } from '@purlay/types';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { codeOf, failureKey, useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../realtime/realtime-provider';
import { browserSchedule } from '../../realtime/socket';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useWorkspace } from '../shell/workspace';

/** How often the list is read again while an export is being made. */
const EXPORT_POLL_MS = 3_000;

const downloadUrl = (workspaceId: string, exportId: string): string =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/exports/${encodeURIComponent(exportId)}/download`;

export const ExportDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const schedule = useContext(RealtimePortsContext).schedule ?? browserSchedule;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A link followed: what the server holds is read again shortly, so the list says what happened —
  // downloaded, or still ready because the request never reached it, or expired meanwhile.
  const [followed, setFollowed] = useState(false);

  const exports = useQuery({
    queryKey: keys.exports(workspace.id),
    queryFn: async ({ signal }) => await api.exports(workspace.id, signal),
    enabled: open,
  });
  const list = exports.data;
  const making = list?.some((made) => made.status === 'pending') === true;
  const { refetch, dataUpdatedAt } = exports;
  // While one is being made, read again a while after each read — through the schedule the realtime
  // ports carry, so a test moves the time instead of waiting for it.
  useEffect(() => {
    if (!open || !making) return undefined;
    return schedule(() => {
      void refetch();
    }, EXPORT_POLL_MS);
  }, [open, making, dataUpdatedAt, schedule, refetch]);
  useEffect(() => {
    if (!open || !followed) return undefined;
    return schedule(() => {
      setFollowed(false);
      void refetch();
    }, EXPORT_POLL_MS);
  }, [open, followed, schedule, refetch]);

  const change = (wanted: boolean): void => {
    if (!wanted) setProblem(null);
    onOpenChange(wanted);
  };

  const ask = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const asked = await api.requestExport(workspace.id);
      client.setQueryData<WorkspaceExport[]>(keys.exports(workspace.id), (held) => [
        asked,
        ...(held ?? []).filter((made) => made.id !== asked.id),
      ]);
    } catch (failure) {
      setProblem(
        codeOf(failure) === 'EXPORT_IN_PROGRESS'
          ? t('export.inProgress')
          : `${t('export.failed')} ${describe(failure)}`,
      );
      void exports.refetch();
    } finally {
      setBusy(false);
    }
  };

  /**
   * The link is spent the moment it is followed: shown so here at once, so it is not followed twice —
   * and then read from the server, which says whether the download reached it.
   */
  const spent = (exportId: string): void => {
    client.setQueryData<WorkspaceExport[]>(keys.exports(workspace.id), (held) =>
      held?.map((made) =>
        made.id === exportId ? { ...made, status: 'downloaded' as const } : made,
      ),
    );
    setFollowed(true);
  };

  /** The export's own reasons in its own words; a refusal the contract names, as everywhere else. */
  const why = (failure: WorkspaceExport['failure']): string => {
    if (failure === null || failure === 'EXPORT_FAILED') return t('export.failure.failed');
    if (failure === 'EXPORT_ABANDONED') return t('export.failure.abandoned');
    if (failure === 'EXPORT_REQUESTER_GONE') return t('export.failure.requesterGone');
    return t(failureKey(failure));
  };

  const stateOf = (made: WorkspaceExport): React.ReactNode => {
    switch (made.status) {
      case 'pending':
        return <span role="status">{t('export.status.pending')}</span>;
      case 'ready':
        return (
          <a
            href={downloadUrl(workspace.id, made.id)}
            download
            onClick={() => {
              spent(made.id);
            }}
            onAuxClick={() => {
              spent(made.id);
            }}
            className="text-body text-accent-text underline"
          >
            {made.sizeBytes === null || made.expiresAt === null
              ? t('export.downloadPlain')
              : t('export.download', {
                  size: format.bytes(made.sizeBytes),
                  until: format.absolute(made.expiresAt),
                })}
          </a>
        );
      case 'downloaded':
        return t('export.status.downloaded');
      case 'expired':
        return t('export.status.expired');
      case 'failed':
        return <span className="text-danger-text">{why(made.failure)}</span>;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('export.title', { workspace: workspace.name })}
      description={t('export.description')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="primary"
            busy={busy}
            disabled={list === undefined || making}
            onClick={() => {
              void ask();
            }}
          >
            {t('export.request')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {exports.isError ? (
          <div className="flex items-center gap-3">
            <p className="text-body text-ink-muted">{describe(exports.error)}</p>
            <Button
              onClick={() => {
                void exports.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : list === undefined ? (
          <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
            <Skeleton />
          </LoadingStatus>
        ) : list.length === 0 ? (
          <p className="text-body text-ink-muted">{t('export.empty')}</p>
        ) : (
          <ul aria-label={t('export.list')} className="flex flex-col gap-2">
            {list.map((made) => (
              <li key={made.id} className="flex flex-col gap-1">
                <span className="text-label text-ink-muted">
                  {t('export.asked', { when: format.absolute(made.createdAt) })}
                </span>
                <span className="text-body text-ink">{stateOf(made)}</span>
              </li>
            ))}
          </ul>
        )}
        {problem !== null && (
          <p role="alert" className="text-label text-danger-text">
            {problem}
          </p>
        )}
      </div>
    </Dialog>
  );
};
