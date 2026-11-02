/**
 * How long a channel keeps its history (D-225), in its details, for an owner: the workspace's window
 * and what this channel keeps, each said in words, and a choice of keeping longer — forever, or a window
 * past the workspace's — or following it again. Never shorter: the windows offered start at the
 * workspace's, and the server refuses anything else (`409 RETENTION_TOO_SHORT`), which is said here in
 * words of its own.
 *
 * Choosing something that keeps less than now — following the workspace again, or a shorter window —
 * deletes what is past it the next night, so the card says so and the button says it again in red, as
 * the workspace's own card does.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Channel, ChannelRetentionFloor } from '@purlay/types';
import { useId, useState } from 'react';
import { useApi } from '../../data/api-provider';
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { keys } from '../../data/keys';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Select } from '../../ui/select';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { useToast } from '../../ui/toast';
import { useWorkspace } from '../shell/workspace';

/** The windows offered past the workspace's, in days, as the workspace's own card offers them. */
const OFFERED_DAYS: readonly number[] = [90, 365, 730, 1825];

const WORKSPACE = 'workspace';
const FOREVER = 'forever';

/** What the purge keeps for a choice: the longer of the two windows, `null` — everything — longest. */
const keptFor = (workspaceDays: number | null, floor: ChannelRetentionFloor): number | null => {
  if (workspaceDays === null || floor === 'forever') return null;
  return floor === null ? workspaceDays : Math.max(workspaceDays, floor);
};

/** Whether `next` keeps less than `now`: everything is the longest of all. */
const keepsLess = (next: number | null, now: number | null): next is number =>
  next !== null && (now === null || next < now);

const valueOf = (floor: ChannelRetentionFloor): string =>
  floor === null ? WORKSPACE : floor === 'forever' ? FOREVER : String(floor);

const floorOf = (value: string): ChannelRetentionFloor =>
  value === WORKSPACE ? null : value === FOREVER ? 'forever' : Number(value);

const sectionTitle = 'text-label font-semibold text-ink';

export const ChannelRetentionSection = ({
  channel,
}: {
  readonly channel: Channel;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const headingId = useId();
  const selectId = useId();
  const [chosen, setChosen] = useState<ChannelRetentionFloor | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const setting = useQuery({
    queryKey: keys.channelRetention(channel.id),
    queryFn: async ({ signal }) => await api.channelRetention(channel.id, signal),
  });

  /** A window in the words a person uses: so many years, or so many days. Forever has sentences of its own. */
  const named = (days: number): string =>
    days % 365 === 0
      ? t('settings.data.years', { count: days / 365 })
      : t('retention.days', { days: String(days) });

  const save = async (event: React.SyntheticEvent, next: ChannelRetentionFloor): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const saved = await api.setChannelRetention(channel.id, next);
      client.setQueryData(keys.channelRetention(channel.id), saved);
      // The workspace's card counts the channels that keep longer.
      void client.invalidateQueries({ queryKey: keys.retention(workspace.id) });
      setChosen(undefined);
      show({ message: t('retention.saved') });
    } catch (failure) {
      if (isApiError(failure) && failure.code === 'RETENTION_TOO_SHORT') {
        setProblem(t('channelRetention.tooShort'));
        // The workspace's window moved since this was read: read it again, so the choice is offered anew.
        void setting.refetch();
      } else {
        setProblem(`${t('retention.failed')} ${describe(failure)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const body = ((): React.JSX.Element => {
    if (setting.isError) {
      return (
        <div className="flex items-center gap-3 p-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">{describe(setting.error)}</p>
          <Button
            onClick={() => {
              void setting.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    if (setting.data === undefined) {
      return (
        <LoadingStatus label={t('common.loading')} className="p-4">
          <Skeleton />
        </LoadingStatus>
      );
    }
    const { workspaceDays, keepsAtLeast, effectiveDays } = setting.data;
    const next = chosen === undefined ? keepsAtLeast : chosen;
    const nextKept = keptFor(workspaceDays, next);
    const shortenTo = keepsLess(nextKept, effectiveDays) ? nextKept : null;
    // The windows past the workspace's, and the channel's own among them however it was set — a
    // floor the workspace has since outgrown is still what is held, so it is shown as itself.
    const days = OFFERED_DAYS.filter((each) => workspaceDays !== null && each > workspaceDays);
    const offered: readonly ChannelRetentionFloor[] = [
      null,
      ...[...new Set([...days, ...(typeof keepsAtLeast === 'number' ? [keepsAtLeast] : [])])].sort(
        (a, b) => a - b,
      ),
      'forever',
    ];
    const label = (floor: ChannelRetentionFloor): string =>
      floor === null
        ? t('channelRetention.followsWorkspace')
        : floor === 'forever'
          ? t('settings.data.forever')
          : named(floor);

    return (
      <form
        onSubmit={(event) => {
          void save(event, next);
        }}
        className="flex flex-col gap-3 p-4"
      >
        <p className="text-body text-ink-muted">
          {workspaceDays === null
            ? t('channelRetention.workspaceForever')
            : t('channelRetention.workspace', { kept: named(workspaceDays) })}{' '}
          {effectiveDays === null
            ? t('channelRetention.keepsEverything')
            : t('channelRetention.keeps', { kept: named(effectiveDays) })}
        </p>
        <div className="flex flex-col gap-2">
          <label htmlFor={selectId} className="text-label text-ink">
            {t('channelRetention.label')}
          </label>
          <Select
            id={selectId}
            className="w-full"
            value={valueOf(next)}
            onChange={(event) => {
              setChosen(floorOf(event.target.value));
              setProblem(null);
            }}
          >
            {offered.map((floor) => (
              <option key={valueOf(floor)} value={valueOf(floor)}>
                {label(floor)}
              </option>
            ))}
          </Select>
        </div>
        {shortenTo !== null && (
          <p
            role="note"
            className="rounded-lg bg-danger-subtle px-4 py-3 text-label text-danger-text"
          >
            {t('channelRetention.warning', { kept: named(shortenTo) })}
          </p>
        )}
        <div className="flex items-center justify-end gap-3">
          {problem !== null && (
            <p role="alert" className="min-w-0 flex-1 text-label text-danger-text">
              {problem}
            </p>
          )}
          <Button
            type="submit"
            variant={shortenTo === null ? 'primary' : 'danger'}
            busy={busy}
            disabled={next === keepsAtLeast}
          >
            {shortenTo === null
              ? t('channelRetention.save')
              : t('channelRetention.shorten', { kept: named(shortenTo) })}
          </Button>
        </div>
      </form>
    );
  })();

  return (
    <section aria-labelledby={headingId} className="flex flex-col">
      <h3 id={headingId} className={cn(sectionTitle, 'mb-2')}>
        {t('channelRetention.title')}
      </h3>
      <div className="flex flex-col rounded-lg border-hairline border-border-subtle">{body}</div>
    </section>
  );
};
