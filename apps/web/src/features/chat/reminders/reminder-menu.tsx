/**
 * "Remind me…" in a message's More menu, and the mark a message with a reminder carries in the feed.
 *
 * Without a reminder the item opens the presets (`presets.ts`) and "Pick date and time…"; with one it
 * says when — "Reminder: Nov 19, 2026, 09:00" — and offers Change… and Remove reminder. A reminder is
 * the caller's own and works on any message they can read: a channel's, a thread's reply, a
 * conversation's.
 */
import type { Message } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { MenuItem, MenuSub } from '../../../ui/menu';
import { useFeedPorts } from '../channel/feed-ports';
import { reminderPresets, type PresetId } from './presets';
import { useReminderActions, useReminderOf } from './use-reminders';

const PRESET_LABELS = {
  in20m: 'reminders.in20m',
  in1h: 'reminders.in1h',
  in3h: 'reminders.in3h',
  tomorrow: 'reminders.tomorrow',
  monday: 'reminders.monday',
} as const satisfies Record<PresetId, string>;

/** The menu's reminder entry; `onPick` opens the dialog that asks for a date and time. */
export const ReminderMenuItem = ({
  message,
  onPick,
}: {
  readonly message: Message;
  readonly onPick: () => void;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const clock = useFeedPorts().clock;
  const actions = useReminderActions();
  const reminder = useReminderOf(message);
  if (actions === null || message.deletedAt !== null) return null;
  if (reminder !== undefined)
    return (
      <MenuSub
        glyph="reminder"
        label={t('reminders.current', { when: format.absolute(reminder.remindAt) })}
      >
        <MenuItem glyph="edit" onSelect={onPick}>
          {t('reminders.change')}
        </MenuItem>
        <MenuItem
          glyph="delete"
          onSelect={() => {
            actions.cancel(message);
          }}
        >
          {t('reminders.remove')}
        </MenuItem>
      </MenuSub>
    );
  return (
    <MenuSub glyph="reminder" label={t('reminders.remind')}>
      {reminderPresets(clock.now(), format).map(({ id, at }) => (
        <MenuItem
          key={id}
          onSelect={() => {
            actions.set(message, at);
          }}
        >
          {t(PRESET_LABELS[id])}
        </MenuItem>
      ))}
      <MenuItem glyph="calendar" onSelect={onPick}>
        {t('reminders.pick')}
      </MenuItem>
    </MenuSub>
  );
};

/** "Reminder: …" under a message that has one, quiet as the pinned mark beside it is. */
export const ReminderMark = ({
  message,
}: {
  readonly message: Message;
}): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const reminder = useReminderOf(message);
  if (reminder === undefined) return null;
  const text = t('reminders.current', { when: format.absolute(reminder.remindAt) });
  return (
    <span
      data-reminder-mark=""
      title={text}
      className="inline-flex items-center gap-1 text-caption text-ink-subtle"
    >
      <Icon name="reminder" size="sm" />
      {text}
    </span>
  );
};
