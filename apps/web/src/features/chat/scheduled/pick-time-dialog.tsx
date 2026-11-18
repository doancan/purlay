/**
 * Any time from a minute to a year away, typed or picked in the browser's own date and time field.
 *
 * The field holds the viewer's wall-clock time, and that is how it is read (`fromInputValue`). A time
 * that is not allowed is said in place, as it is typed, and the way on is to change it: nothing is
 * scheduled from here until the time is one the server would accept.
 */
import { useContext, useRef, useState } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { RealtimePortsContext } from '../../../realtime/realtime-provider';
import { systemClock } from '../../../system-clock';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { describeWhen, schedulePresets } from './presets';
import {
  checkSendAt,
  fromInputValue,
  inputBounds,
  toInputValue,
  type SendAtCheck,
} from './typed-time';

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
  // Opens on tomorrow morning: the commonest wish, and one the person only has to confirm.
  const [value, setValue] = useState(() => {
    const tomorrow = schedulePresets(clock(), format).find((preset) => preset.id === 'tomorrow');
    return tomorrow === undefined ? '' : toInputValue(tomorrow.at, format);
  });
  // Read at every render: the bounds move with the clock, and a dialog left open must not go stale.
  const now = clock();
  const bounds = inputBounds(now, format);
  const chosen = fromInputValue(value, format);
  const check: SendAtCheck = checkSendAt(chosen, now);
  const error =
    check === 'ok'
      ? undefined
      : t(
          check === 'invalid'
            ? 'scheduled.time.invalid'
            : check === 'tooSoon'
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
    >
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen === null || check !== 'ok') {
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
          {...(chosen !== null && check === 'ok'
            ? { hint: t('scheduled.dialog.hint', { when: describeWhen(chosen, now, format, t) }) }
            : {})}
        />
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary">
            {t('scheduled.dialog.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};
