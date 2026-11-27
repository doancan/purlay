/**
 * How much a message asks of its recipient (#1381): the mark drawn under an important or urgent one, and the choice a
 * composer offers where the server would accept one. Words and a glyph, never colour alone.
 */
import type { Message, MessagePriority } from '@purlay/types';
import { Icon } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { cn } from '../../../ui/cn';
import { Select } from '../../../ui/select';

/** The marked priorities of a message, which is none for a normal one. */
const priorityOf = (message: Pick<Message, 'priority'>): 'important' | 'urgent' | null =>
  message.priority ?? null;

/** "Important" or "Urgent", under a message that is one. */
export const PriorityMark = ({
  message,
}: {
  readonly message: Pick<Message, 'priority'>;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const priority = priorityOf(message);
  if (priority === null) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-caption font-medium',
        priority === 'urgent' ? 'text-danger-text' : 'text-warning-text',
      )}
    >
      <Icon name={priority === 'urgent' ? 'notify-all' : 'notifications'} size="sm" />
      {t(priority === 'urgent' ? 'priority.urgent' : 'priority.important')}
    </span>
  );
};

const CHOICES: readonly MessagePriority[] = ['normal', 'important', 'urgent'];

/**
 * What the person picks to send it as. The shared native select: keyboard and screen reader come with it, and it is
 * drawn as the product's other fields are. The caller draws it only where the server accepts a non-normal priority.
 */
export const PriorityChoice = ({
  value,
  onChange,
}: {
  readonly value: MessagePriority;
  readonly onChange: (next: MessagePriority) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Select
      aria-label={t('priority.label')}
      value={value}
      onChange={(event) => {
        const next = CHOICES.find((choice) => choice === event.target.value);
        if (next !== undefined) onChange(next);
      }}
      className="shrink-0"
    >
      {CHOICES.map((choice) => (
        <option key={choice} value={choice}>
          {t(`priority.${choice}`)}
        </option>
      ))}
    </Select>
  );
};
