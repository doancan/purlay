/**
 * Any time from a minute to a year away, typed or picked in the browser's own date and time field.
 *
 * The field holds the viewer's wall-clock time, and that is how it is read (`validateReminder`, the same check the reminders make). A time
 * that is not allowed is said in place, as it is typed, and the way on is to change it: nothing is
 * scheduled from here until the time is one the server would accept.
 */
import { useContext, useId, useRef, useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { systemClock } from '../../../system-clock';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { describeWhen, schedulePresets } from './presets';
import { reminderBounds, validateReminder } from '../reminders/presets';

export const PickTimeDialog = ({
  onPick,
  onClose,
  returnFocus,
}: {
  readonly onPick: (at: Date) => void;
  readonly onClose: () => void;
  readonly returnFocus: () => HTMLElement | null;
}): React.JSX.Element => {
  const { t, format } = useI18n();
  const clock = (useContext(RealtimePortsContext).clock ?? systemClock).now;
  const field = useRef<HTMLInputElement>(null);
  const formId = useId();
  // Opens on tomorrow morning: the commonest wish, and one the person only has to confirm.
  const [value, setValue] = useState(() => {
    const tomorrow = schedulePresets(clock(), format).find((preset) => preset.id === 'tomorrow');
    return tomorrow === undefined ? '' : format.inputValue(tomorrow.at);
  });
  // Read at every render: the bounds move with the clock, and a dialog left open must not go stale.
  const now = clock();
  const bounds = reminderBounds(now, format);
  const checked = validateReminder(value, now, format);
  const chosen = checked.ok ? new Date(checked.at) : null;
  const error = checked.ok
    ? undefined
    : t(
        checked.reason === 'missing'
          ? 'scheduled.time.invalid'
          : checked.reason === 'past'
            ? 'scheduled.time.tooSoon'
            : 'scheduled.time.tooFar',
      );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('scheduled.send')}
      description={t('scheduled.dialog.description')}
      closeLabel={t('common.close')}
      returnFocus={returnFocus}
      // The dialog's own footer, as the reminder's: Cancel quiet beside the one way on.
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} variant="primary">
            {t('scheduled.dialog.confirm')}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen === null) {
            field.current?.focus();
            return;
          }
          onPick(chosen);
        }}
      >
        <TextField
          ref={field}
          label={t('scheduled.dialog.field')}
          type="datetime-local"
          value={value}
          min={bounds.min}
          max={bounds.max}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          {...(error === undefined ? {} : { error })}
          {...(chosen !== null
            ? { hint: t('scheduled.dialog.hint', { when: describeWhen(chosen, now, format, t) }) }
            : {})}
        />
      </form>
    </Dialog>
  );
};
