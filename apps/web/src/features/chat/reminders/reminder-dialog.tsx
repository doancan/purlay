/**
 * Pick date and time… (and Change…): a native date-and-time input in the viewer's time zone, a minute
 * ahead at the soonest and a year at the latest (`presets.ts`). A time that will not do is said on the
 * field before anything is asked of the server, which holds the same bounds.
 *
 * Opened through the deferred door (`app/deferred.ts`): few people open it, so it is not in chat's chunk.
 */
import { useState } from 'react';
import type { Message } from '@purlay/types';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { Dialog } from '../../../ui/dialog';
import { TextField } from '../../../ui/text-field';
import { useFeedPorts } from '../channel/feed-ports';
import { reminderBounds, reminderPresets, validateReminder } from './presets';
import { useReminderActions, useReminderOf } from './use-reminders';

export const ReminderDialog = ({
  message,
  open,
  onOpenChange,
}: {
  readonly message: Message;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const clock = useFeedPorts().clock;
  const actions = useReminderActions();
  const current = useReminderOf(message);
  const [typed, setTyped] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);
  if (actions === null) return null;

  const now = clock.now();
  const bounds = reminderBounds(now, format);
  // What the field holds: what was typed, else the reminder the message has, else tomorrow morning.
  const tomorrow = reminderPresets(now, format).find(({ id }) => id === 'tomorrow');
  const value = typed ?? format.inputValue(current?.remindAt ?? tomorrow?.at ?? now.toISOString());
  const check = validateReminder(value, now, format);
  const error =
    asked && !check.ok
      ? t(
          check.reason === 'missing'
            ? 'reminders.error.missing'
            : check.reason === 'past'
              ? 'reminders.error.past'
              : 'reminders.error.far',
        )
      : undefined;

  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) {
      setTyped(null);
      setAsked(false);
    }
  };

  const submit = (): void => {
    setAsked(true);
    if (!check.ok) return;
    actions.set(message, check.at);
    close(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={t('reminders.dialog.title')}
      description={t('reminders.dialog.body')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              close(false);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={submit}>
            {t(current === undefined ? 'reminders.dialog.set' : 'reminders.dialog.save')}
          </Button>
        </>
      }
    >
      {/* Enter in the field asks, as the button does. */}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <TextField
          label={t('reminders.dialog.field')}
          type="datetime-local"
          value={value}
          min={bounds.min}
          max={bounds.max}
          required
          {...(error === undefined ? {} : { error })}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
        />
      </form>
    </Dialog>
  );
};
