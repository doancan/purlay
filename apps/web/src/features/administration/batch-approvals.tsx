import { useEffect, useRef, useState } from 'react';
import {
  SERVER_APPROVAL_BATCH_MAX,
  type ServerUser,
  type ServerBatchApprovalResponse,
} from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { SettingsCard } from '../settings/page';
import { useAdministrationClient } from './context';

export const BatchApprovals = ({
  users,
  selected,
  busy,
  loading,
  onSelection,
  onBusy,
  refresh,
}: {
  readonly users: readonly ServerUser[];
  readonly selected: readonly ServerUser[];
  readonly busy: boolean;
  readonly loading: boolean;
  readonly onSelection: (users: readonly ServerUser[]) => void;
  readonly onBusy: (busy: boolean) => void;
  readonly refresh: () => Promise<void>;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useAdministrationClient();
  const [confirming, setConfirming] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [report, setReport] = useState<{
    users: readonly ServerUser[];
    response: ServerBatchApprovalResponse;
  } | null>(null);
  const operation = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      operation.current?.abort();
    };
  }, []);
  const pending = users.filter((user) => user.admissionState === 'pending');
  const pageSelection = [
    ...new Map([...selected, ...pending].map((user) => [user.id, user])).values(),
  ];
  const approve = async (): Promise<void> => {
    if (busy || operation.current !== null || selected.length === 0) return;
    const snapshot = [...selected];
    const controller = new AbortController();
    operation.current = controller;
    onBusy(true);
    setUncertain(false);
    setReport(null);
    try {
      const response = await client.approveAccounts(
        snapshot.map((user) => user.id),
        controller.signal,
      );
      if (!mounted.current) return;
      setReport({ users: snapshot, response });
      const approved = new Set(
        response.results
          .filter((result) => result.outcome === 'approved')
          .map((result) => result.userId),
      );
      onSelection(snapshot.filter((user) => !approved.has(user.id)));
      setConfirming(false);
    } catch {
      if (!mounted.current) return;
      setUncertain(true);
      setConfirming(false);
    } finally {
      operation.current = null;
      if (mounted.current) {
        await refresh();
        onBusy(false);
      }
    }
  };
  return (
    <>
      {(pending.length > 0 || selected.length > 0 || report !== null || uncertain) && (
        <div className="flex flex-col gap-3">
          <p className="text-body text-ink-muted">
            {t('admin.bulk.limit', { count: SERVER_APPROVAL_BATCH_MAX })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              disabled={
                busy ||
                loading ||
                pending.length === 0 ||
                pageSelection.length > SERVER_APPROVAL_BATCH_MAX
              }
              onClick={() => {
                onSelection(pageSelection);
              }}
            >
              {t('admin.bulk.selectPage')}
            </Button>
            <Button
              disabled={busy || selected.length === 0}
              onClick={() => {
                onSelection([]);
              }}
            >
              {t('admin.bulk.clear')}
            </Button>
            <span className="text-label text-ink-muted">
              {t('admin.bulk.selected', { count: selected.length })}
            </span>
            <Button
              variant="primary"
              disabled={busy || selected.length === 0}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t('admin.bulk.approve')}
            </Button>
          </div>
          {uncertain && (
            <div role="alert" className="flex flex-wrap items-center gap-3">
              <p className="text-body text-danger-text">{t('admin.bulk.uncertain')}</p>
              <Button
                disabled={busy}
                onClick={() => {
                  void refresh();
                }}
              >
                {t('admin.bulk.refresh')}
              </Button>
            </div>
          )}
          {report !== null && (
            <SettingsCard title={t('admin.bulk.results')}>
              <p role="status" className="px-6 py-4 text-body text-ink">
                {t('admin.bulk.summary', {
                  approved: report.response.results.filter(
                    (result) => result.outcome === 'approved',
                  ).length,
                  total: report.response.results.length,
                })}
              </p>
              <ul className="flex flex-col">
                {report.response.results.map((result) => {
                  const user = report.users.find((person) => person.id === result.userId);
                  return (
                    <li
                      key={result.userId}
                      className="flex flex-col gap-1 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4"
                    >
                      <span className="text-label text-ink break-words">
                        {user?.displayName ?? result.userId}
                      </span>
                      <span className="text-caption text-ink-muted break-all">{user?.email}</span>
                      <span className="text-body text-ink-muted">
                        {t(`admin.bulk.outcome.${result.outcome}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </SettingsCard>
          )}
        </div>
      )}
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!busy) setConfirming(open);
        }}
        title={t('admin.bulk.approve')}
        description={t('admin.bulk.confirmBody', { count: selected.length })}
        closeLabel={t('common.close')}
        footer={
          <>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              busy={busy}
              disabled={busy}
              onClick={() => {
                void approve();
              }}
            >
              {t('admin.bulk.confirm')}
            </Button>
          </>
        }
      >
        <ul
          tabIndex={0}
          aria-label={t('admin.bulk.confirmList')}
          className="flex max-h-palette-list flex-col gap-3 overflow-y-auto"
        >
          {selected.map((user) => (
            <li key={user.id} className="flex flex-col gap-1">
              <span className="text-body text-ink break-words">{user.displayName}</span>
              <span className="text-caption text-ink-muted break-all">{user.email}</span>
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
};
