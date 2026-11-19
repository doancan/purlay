/**
 * "Send later": the button beside Send, and the menu of times it opens.
 *
 * The presets are worked out when the menu opens and again when one is chosen, so "In 1 hour" is an
 * hour from the press and not from the last render. "Pick date and time…" opens a dialog that is loaded
 * when it is first wanted. Nothing here knows what is in the box: the composer is told the time.
 */
import { lazy, Suspense, useContext, useRef, useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { systemClock } from '../../../system-clock';
import { IconButton } from '../../../ui/icon-button';
import { Menu, MenuItem, MenuSeparator } from '../../../ui/menu';
import { schedulePresets, type PresetId, type SchedulePreset } from './presets';

const PickTimeDialog = lazy(() =>
  import('./pick-time-dialog').then((module) => ({ default: module.PickTimeDialog })),
);

/** The hour the morning presets send at, as the menu says it. */
const MORNING = '09:00';

export const SendLater = ({
  onSchedule,
}: {
  /** Told the instant that was chosen; the composer schedules what is in the box for it. */
  readonly onSchedule: (at: Date) => void;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const clock = (useContext(RealtimePortsContext).clock ?? systemClock).now;
  const [opened, setOpened] = useState<Date | null>(null);
  const [picking, setPicking] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Every preset says the clock time it will send at, so a person picks a time and not a duration.
  const label = (preset: SchedulePreset): string =>
    preset.id === 'hour'
      ? t('scheduled.preset.hour', { time: format.inputValue(preset.at).slice(-5) })
      : t(preset.id === 'tomorrow' ? 'scheduled.preset.tomorrow' : 'scheduled.preset.monday', {
          time: MORNING,
        });
  const choose = (id: PresetId): void => {
    const chosen = schedulePresets(clock(), format).find((preset) => preset.id === id);
    if (chosen !== undefined) onSchedule(chosen.at);
  };
  return (
    <>
      <Menu
        align="end"
        side="top"
        onOpenChange={(open) => {
          if (open) setOpened(clock());
        }}
        // The dialog takes focus when a time is to be picked; the menu must not take it back.
        returnFocus={() => !picking}
        trigger={<IconButton ref={trigger} label={t('scheduled.send')} glyph="schedule" />}
      >
        {schedulePresets(opened ?? clock(), format).map((preset) => (
          <MenuItem
            key={preset.id}
            onSelect={() => {
              choose(preset.id);
            }}
          >
            {label(preset)}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onSelect={() => {
            setPicking(true);
          }}
        >
          {t('scheduled.preset.pick')}
        </MenuItem>
      </Menu>
      {picking && (
        <Suspense fallback={null}>
          <PickTimeDialog
            returnFocus={() => trigger.current}
            onClose={() => {
              setPicking(false);
            }}
            onPick={(at) => {
              setPicking(false);
              onSchedule(at);
            }}
          />
        </Suspense>
      )}
    </>
  );
};
