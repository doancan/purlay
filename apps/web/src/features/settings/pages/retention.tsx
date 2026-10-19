/**
 * How long the workspace keeps its history (D-27 §1, D-139 §4): an owner's choice, forever by default.
 * The windows offered are the ones a team means — a month, a quarter, a year or more — plus whatever
 * the server already holds, so nothing set some other way is shown as something else.
 *
 * Shortening it is the one thing here that destroys: the card says what will be deleted, the button
 * says it again in red, and the trail will say who chose it. Making it longer, or forever, is said
 * plainly — it deletes nothing.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useToast } from '../../../ui/toast';
import { Select } from '../../../ui/select';
import { useWorkspace } from '../../shell/workspace';
import { SaveOutcome, SettingsCard, SettingsRow } from '../page';

/** The windows offered, in days; `null` is forever. */
const OFFERED: readonly (number | null)[] = [null, 30, 90, 365, 730, 1825];

/** Whether `next` keeps less than `now`: forever is the longest of all. */
const shorter = (next: number | null, now: number | null): next is number =>
  next !== null && (now === null || next < now);

const FOREVER = 'forever';

export const RetentionCard = (): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const selectId = useId();
  const [chosen, setChosen] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const setting = useQuery({
    queryKey: keys.retention(workspace.id),
    queryFn: async ({ signal }) => await api.retention(workspace.id, signal),
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

  const save = async (event: React.SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (next === undefined) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.setRetention(workspace.id, next);
      client.setQueryData(keys.retention(workspace.id), saved);
      setChosen(undefined);
      show({ message: t('retention.saved') });
    } catch (failure) {
      setProblem(`${t('retention.failed')} ${describe(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  /** A window in the words a person uses: forever, so many years, or so many days. */
  const named = (days: number | null): string =>
    days === null
      ? t('settings.data.forever')
      : days % 365 === 0
        ? t('settings.data.years', { count: days / 365 })
        : t('retention.days', { days: String(days) });

  return (
    <form
      onSubmit={(event) => {
        void save(event);
      }}
    >
      <SettingsCard
        title={t('settings.data.retention')}
        description={t('retention.description')}
        footer={
          <>
            <SaveOutcome outcome={problem === null ? null : { ok: false, words: problem }} />
            <Button
              type="submit"
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
          <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
            <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(setting.error)}</p>
            <Button
              onClick={() => {
                void setting.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : now === undefined ? (
          <LoadingStatus label={t('common.loading')} className="px-6 py-5">
            <Skeleton />
          </LoadingStatus>
        ) : (
          <>
            <SettingsRow label={t('retention.label')} htmlFor={selectId} fill>
              <Select
                id={selectId}
                className="w-full"
                value={next === null ? FOREVER : String(next)}
                onChange={(event) => {
                  const value = event.target.value;
                  setChosen(value === FOREVER ? null : Number(value));
                }}
              >
                {offered.map((days) => (
                  <option key={days ?? FOREVER} value={days === null ? FOREVER : String(days)}>
                    {named(days)}
                  </option>
                ))}
              </Select>
            </SettingsRow>
            {shortenTo !== null && (
              <p
                role="note"
                className="mx-6 mb-5 rounded-lg bg-danger-subtle px-4 py-3 text-label text-danger-text max-narrow:mx-4"
              >
                {t('retention.warning', { days: String(shortenTo) })}
              </p>
            )}
          </>
        )}
      </SettingsCard>
    </form>
  );
};
