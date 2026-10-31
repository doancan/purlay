/**
 * Quiet hours (D-234), on Notifications: the hours of the week in which nothing interrupts — Deep Work's
 * hold, every week, by itself. Read on the clock of the person's profile, which the card names; with no
 * time zone on the profile it says so and leads there, since an evening means nothing without one.
 *
 * Off, or on with a start, an end and the days it starts on. An end earlier than the start runs past
 * midnight, and the card says so in words. Saved when Save is pressed; what the server refuses is said.
 */
import { MINUTES_PER_DAY, type QuietHours } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Link } from '../../../router/router-provider';
import { Button } from '../../../ui/button';
import { Checkbox } from '../../../ui/checkbox';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useQuietHoursSetting } from '../../shell/quiet-hours';
import { useWorkspace } from '../../shell/workspace';
import { SaveOutcome, SettingsCard, SettingsRow } from '../page';

/** What a new window starts as: weekday evenings, 19:00 to 09:00. */
const SUGGESTED: QuietHours = { from: 19 * 60, to: 9 * 60, days: [1, 2, 3, 4, 5] };

/** Monday first, as a week is read where the product is used; the values stay Sunday-based. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const asClock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

const fromClock = (text: string): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes < MINUTES_PER_DAY ? minutes : null;
};

export const QuietHoursCard = (): React.JSX.Element => {
  const { t, locale } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { workspace } = useWorkspace();
  const fromId = useId();
  const toId = useId();
  const setting = useQuietHoursSetting();
  // What is being edited; until something is, the card shows what the server keeps.
  const [draft, setDraft] = useState<QuietHours | null | undefined>(undefined);
  // What is in each time field as typed, until it is a whole time; a field shows the window otherwise.
  const [typed, setTyped] = useState<{ readonly from?: string; readonly to?: string }>({});
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; words: string } | null>(null);

  const dayName = (day: number): string =>
    // 2023-01-01 was a Sunday: its week names each day in the reader's language.
    new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2023, 0, 1 + day)),
    );

  if (setting.data === undefined) {
    return (
      <SettingsCard title={t('quietHours.title')} description={t('quietHours.description')}>
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
          <Skeleton />
        </LoadingStatus>
      </SettingsCard>
    );
  }
  const { timeZone } = setting.data;
  const shown = draft === undefined ? setting.data.quietHours : draft;

  if (timeZone === null) {
    return (
      <SettingsCard title={t('quietHours.title')} description={t('quietHours.description')}>
        <SettingsRow label={t('quietHours.needsZone')}>
          <Link to="settings" params={{ slug: workspace.slug, section: 'profile' }}>
            {t('quietHours.setZone')}
          </Link>
        </SettingsRow>
      </SettingsCard>
    );
  }

  const change = (next: QuietHours | null): void => {
    setDraft(next);
    setOutcome(null);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setOutcome(null);
    try {
      const kept = await api.setQuietHours({ quietHours: shown });
      client.setQueryData(keys.quietHours, kept);
      setDraft(undefined);
      setTyped({});
      setOutcome({ ok: true, words: t('quietHours.saved') });
    } catch (failure) {
      setOutcome({ ok: false, words: `${t('quietHours.failed')} ${describe(failure)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title={t('quietHours.title')}
      description={t('quietHours.description')}
      footer={
        <>
          <SaveOutcome outcome={outcome} />
          <Button
            variant="primary"
            busy={busy}
            disabled={draft === undefined || (shown !== null && shown.days.length === 0)}
            onClick={() => {
              void save();
            }}
          >
            {t('quietHours.save')}
          </Button>
        </>
      }
    >
      <SettingsRow label={t('quietHours.on')} description={t('quietHours.zone', { timeZone })}>
        <Checkbox
          aria-label={t('quietHours.on')}
          checked={shown !== null}
          onChange={(event) => {
            change(event.target.checked ? SUGGESTED : null);
          }}
        />
      </SettingsRow>
      {shown !== null && (
        <>
          <SettingsRow
            label={t('quietHours.between')}
            {...(shown.from > shown.to ? { description: t('quietHours.overnight') } : {})}
          >
            <span className="flex flex-wrap items-center gap-2">
              <label htmlFor={fromId} className="text-label text-ink-muted">
                {t('quietHours.from')}
              </label>
              <input
                id={fromId}
                type="time"
                value={typed.from ?? asClock(shown.from)}
                className="h-control rounded-md border-hairline border-border-subtle bg-surface-000 px-2 text-body text-ink"
                onChange={(event) => {
                  setTyped({ ...typed, from: event.target.value });
                  const from = fromClock(event.target.value);
                  if (from !== null) change({ ...shown, from });
                }}
              />
              <label htmlFor={toId} className="text-label text-ink-muted">
                {t('quietHours.to')}
              </label>
              <input
                id={toId}
                type="time"
                value={typed.to ?? asClock(shown.to)}
                className="h-control rounded-md border-hairline border-border-subtle bg-surface-000 px-2 text-body text-ink"
                onChange={(event) => {
                  setTyped({ ...typed, to: event.target.value });
                  const to = fromClock(event.target.value);
                  if (to !== null) change({ ...shown, to });
                }}
              />
            </span>
          </SettingsRow>
          <SettingsRow label={t('quietHours.days')} wide>
            <span
              className="flex flex-wrap gap-x-4 gap-y-2"
              role="group"
              aria-label={t('quietHours.days')}
            >
              {WEEK.map((day) => (
                <label key={day} className="inline-flex items-center gap-2 text-body text-ink">
                  <Checkbox
                    checked={shown.days.includes(day)}
                    onChange={(event) => {
                      const days = event.target.checked
                        ? [...shown.days, day].sort()
                        : shown.days.filter((each) => each !== day);
                      change({ ...shown, days });
                    }}
                  />
                  {dayName(day)}
                </label>
              ))}
            </span>
          </SettingsRow>
        </>
      )}
    </SettingsCard>
  );
};
