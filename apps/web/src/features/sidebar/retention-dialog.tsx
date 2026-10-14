/**
 * How long the workspace keeps its history (D-27 §1, D-139 §4): an owner's choice, forever by default.
 * The windows offered are the ones a team means — a month, a quarter, a year or more — plus whatever
 * the server already holds, so nothing set some other way is shown as something else.
 *
 * Shortening it is the one thing here that destroys: the dialog says what will be deleted, the button
 * says it again in red, and the trail will say who chose it. Making it longer, or forever, is said
 * plainly — it deletes nothing.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useToast } from '../../ui/toast';
import { useWorkspace } from '../shell/workspace';

/** The windows offered, in days; `null` is forever. */
const OFFERED: readonly (number | null)[] = [null, 30, 90, 365, 730, 1825];

/** Whether `next` keeps less than `now`: forever is the longest of all. */
const shorter = (next: number | null, now: number | null): next is number =>
  next !== null && (now === null || next < now);

const FOREVER = 'forever';

export const RetentionDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const formId = useId();
  const selectId = useId();
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const setting = useQuery({
    queryKey: keys.retention(workspace.id),
    queryFn: async ({ signal }) => await api.retention(workspace.id, signal),
    enabled: open,
  });
  const now = setting.data?.retentionDays;
  const next = chosen === undefined ? now : chosen;
  // Forever first, then the windows from the shortest — with the one held now among them.
  const offered =
    now === undefined || OFFERED.includes(now)
      ? OFFERED
      : [null, ...[...OFFERED, now].filter((days) => days !== null).sort((a, b) => a - b)];
  /** The window that would delete history now kept, or none. */
  const shortenTo = next !== undefined && now !== undefined && shorter(next, now) ? next : null;

  const change = (wanted: boolean): void => {
    if (!wanted) {
      setChosen(undefined);
      setProblem(null);
    }
    onOpenChange(wanted);
  };

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (next === undefined) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.setRetention(workspace.id, next);
      client.setQueryData(keys.retention(workspace.id), saved);
      show({ message: t('retention.saved') });
      change(false);
    } catch (failure) {
      setProblem(`${t('retention.failed')} ${describe(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const named = (days: number | null): string =>
    days === null ? t('retention.forever') : t('retention.days', { days: String(days) });

  return (
    <Dialog
      open={open}
      onOpenChange={change}
      title={t('retention.title', { workspace: workspace.name })}
      description={t('retention.description')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            onClick={() => {
              change(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant={shortenTo === null ? 'primary' : 'danger'}
            busy={busy}
            disabled={next === undefined || next === now}
          >
            {shortenTo === null
              ? t('retention.save')
              : t('retention.shorten', { days: String(shortenTo) })}
          </Button>
        </>
      }
    >
      {setting.isError ? (
        <div className="flex items-center gap-3">
          <p className="text-body text-ink-muted">{describe(setting.error)}</p>
          <Button
            onClick={() => {
              void setting.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : now === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-2">
          <Skeleton />
        </LoadingStatus>
      ) : (
        <form
          id={formId}
          onSubmit={(event) => {
            void save(event);
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor={selectId} className="text-label text-ink">
            {t('retention.label')}
          </label>
          <select
            id={selectId}
            value={next === null ? FOREVER : String(next)}
            onChange={(event) => {
              const value = event.target.value;
              setChosen(value === FOREVER ? null : Number(value));
            }}
            className="rounded-md border-hairline border-border-subtle bg-surface-000 px-2 py-1 text-body text-ink"
          >
            {offered.map((days) => (
              <option key={days ?? FOREVER} value={days === null ? FOREVER : String(days)}>
                {named(days)}
              </option>
            ))}
          </select>
          {shortenTo !== null && (
            <p role="note" className="text-label text-danger-text">
              {t('retention.warning', { days: String(shortenTo) })}
            </p>
          )}
          {problem !== null && (
            <p role="alert" className="text-label text-danger-text">
              {problem}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
};
