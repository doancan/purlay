/**
 * How much room the workspace's files take (D-173): an owner's card on Data & retention, a meter with
 * the numbers in words — "1.2 GB of 5 GB". What counts is what the server counts when it takes an
 * upload, so the meter and a refused file never disagree. The quota is the server operator's to set
 * (`bun run storage:quota`), so nothing here changes it: the card says who does.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { cn } from '../../../ui/cn';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard } from '../page';

/** From here the bar is drawn in the warning tone: a team should hear of it before a file is refused. */
const NEARLY_FULL = 0.9;

export const StorageCard = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const storage = useQuery({
    queryKey: keys.storage(workspace.id),
    queryFn: async ({ signal }) => await api.storage(workspace.id, signal),
  });

  const body = ((): React.JSX.Element => {
    if (storage.isError) {
      return (
        <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(storage.error)}</p>
          <Button
            onClick={() => {
              void storage.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    if (storage.data === undefined) {
      return (
        <LoadingStatus label={t('common.loading')} className="px-6 py-5">
          <Skeleton />
        </LoadingStatus>
      );
    }
    const { usedBytes, quotaBytes } = storage.data;
    const share = quotaBytes === 0 ? 1 : Math.min(1, usedBytes / quotaBytes);
    const full = usedBytes >= quotaBytes;
    const said = t('storage.used', {
      used: format.bytes(usedBytes),
      quota: format.bytes(quotaBytes),
    });
    return (
      <div className="flex flex-col gap-3 px-6 py-5 max-narrow:px-4">
        <div className="flex items-baseline justify-between gap-6 max-narrow:flex-col max-narrow:gap-1">
          <span className="text-label text-ink">{t('storage.label')}</span>
          <span className="font-mono text-label text-ink">{said}</span>
        </div>
        <div
          role="meter"
          aria-label={t('storage.label')}
          aria-valuemin={0}
          aria-valuemax={quotaBytes}
          aria-valuenow={Math.min(usedBytes, quotaBytes)}
          aria-valuetext={said}
          className="h-2 overflow-hidden rounded-pill bg-surface-200"
        >
          <div
            className={cn(
              'h-full rounded-pill',
              full ? 'bg-danger' : share >= NEARLY_FULL ? 'bg-warning' : 'bg-accent',
            )}
            style={{ width: `${String(share * 100)}%` }}
          />
        </div>
        {full ? (
          <p className="text-label text-danger-text">{t('storage.full')}</p>
        ) : (
          <p className="text-label font-normal text-ink-muted">
            {t('storage.left', { left: format.bytes(quotaBytes - usedBytes) })}
          </p>
        )}
      </div>
    );
  })();

  return (
    <SettingsCard title={t('settings.data.storage')} description={t('storage.description')}>
      {body}
    </SettingsCard>
  );
};
