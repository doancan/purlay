/**
 * "Remind me…" in a message's More menu, and the mark a message with a reminder carries in the feed.
 *
 * Without a reminder the item opens the presets (`presets.ts`) and "Pick date and time…"; with one it
 * says when — "Reminder: Tomorrow at 09:00", on the 24-hour clock the presets use — and offers Change… and
 * Remove reminder; the full time is the mark's tip. A reminder is
 * the caller's own and works on any message they can read: a channel's, a thread's reply, a
 * conversation's.
 */
import type { Message } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { MenuItem, MenuSeparator, MenuSub } from '../../../ui/menu';
import { useFeedPorts } from '../channel/feed-ports';
import { describeWhen } from '../scheduled/presets';
import { reminderPresets } from './presets';
import { useReminderActions, useReminderOf } from './use-reminders';

/** The presets that are a span from now: they say the clock time they come to, as Send later's do. */
const SPAN_LABELS = {
  in20m: 'reminders.in20m',
  in1h: 'reminders.in1h',
  in3h: 'reminders.in3h',
} as const;

const DAY_LABELS = {
  tomorrow: 'reminders.tomorrow',
  monday: 'reminders.monday',
} as const;

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
        label={t('reminders.current', {
          when: describeWhen(new Date(reminder.remindAt), clock.now(), format, t),
        })}
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
          {id === 'tomorrow' || id === 'monday'
            ? t(DAY_LABELS[id])
            : t(SPAN_LABELS[id], { time: format.inputValue(at).slice(-5) })}
        </MenuItem>
      ))}
      {/* Apart from the presets, and without a glyph as they are, so every label starts in one column. */}
      <MenuSeparator />
      <MenuItem onSelect={onPick}>{t('reminders.pick')}</MenuItem>
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
  const clock = useFeedPorts().clock;
  const reminder = useReminderOf(message);
  if (reminder === undefined) return null;
  const text = t('reminders.current', {
    when: describeWhen(new Date(reminder.remindAt), clock.now(), format, t),
  });
  return (
    <span
      data-reminder-mark=""
      title={t('reminders.current', { when: format.absolute(reminder.remindAt) })}
      className="inline-flex items-center gap-1 text-caption text-ink-subtle"
    >
      <Icon name="reminder" size="sm" />
      {text}
    </span>
  );
};
