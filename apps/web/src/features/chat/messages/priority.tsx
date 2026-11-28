/**
 * How much a message asks of its recipient (#1381): the mark drawn under an important or urgent one, and the choice a
 * composer offers where the server would accept one. Words and a glyph, never colour alone.
 */
import type { Message, MessagePriority } from '@purlay/types';
import { Icon, type GlyphName } from '../../../components/icon';
import { useI18n } from '../../../i18n/i18n-provider';
import { cn } from '../../../ui/cn';
import { Menu, MenuRadioGroup, MenuRadioItem } from '../../../ui/menu';

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

/** The glyph of each way to send, kept apart from the class lists below: a glyph's name is not a class. */
const GLYPHS = {
  normal: 'send',
  important: 'notifications',
  urgent: 'notify-all',
} as const satisfies Record<MessagePriority, GlyphName>;

/** Each way to send: the tone it is drawn in, so a person sees what they are about to send. */
const LOOKS = {
  normal: {
    ink: 'text-ink-muted',
    trigger: 'border-border-default bg-surface-100 text-ink shadow-card hover:bg-surface-200',
  },
  important: {
    ink: 'text-warning-text',
    trigger: 'border-transparent bg-warning-subtle text-warning-text hover:brightness-95',
  },
  urgent: {
    ink: 'text-danger-text',
    trigger: 'border-transparent bg-danger-subtle text-danger-text hover:brightness-95',
  },
} as const satisfies Record<MessagePriority, { ink: string; trigger: string }>;

/**
 * What the person picks to send it as. A menu of radio choices, each with its glyph and tone, opening upward from the
 * composer with the menus' own motion; the trigger takes the tone of what is chosen and its chevron turns while the menu
 * is open. Words and a glyph, never colour alone. The caller draws it only where the server accepts a non-normal priority.
 */
export const PriorityChoice = ({
  value,
  allowUrgent,
  onChange,
}: {
  readonly value: MessagePriority;
  readonly allowUrgent: boolean;
  readonly onChange: (next: MessagePriority) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const choices = allowUrgent ? CHOICES : CHOICES.slice(0, 2);
  return (
    <Menu
      side="top"
      align="end"
      trigger={
        <button
          type="button"
          aria-label={`${t('priority.label')}: ${t(`priority.${value}`)}`}
          className={cn(
            'group inline-flex h-control shrink-0 items-center gap-1 rounded-md border-hairline px-2 text-label transition-colors duration-hover ease-standard max-narrow:h-touch',
            LOOKS[value].trigger,
          )}
        >
          <Icon name={GLYPHS[value]} size="sm" />
          {t(`priority.${value}`)}
          <span className="inline-flex group-data-[state=open]:hidden">
            <Icon name="expand" size="sm" />
          </span>
          <span className="hidden group-data-[state=open]:inline-flex">
            <Icon name="collapse" size="sm" />
          </span>
        </button>
      }
    >
      <MenuRadioGroup
        value={value}
        onValueChange={(next) => {
          const chosen = choices.find((choice) => choice === next);
          if (chosen !== undefined) onChange(chosen);
        }}
      >
        {choices.map((choice) => (
          <MenuRadioItem
            key={choice}
            value={choice}
            leading={{
              node: (
                <span className={LOOKS[choice].ink}>
                  <Icon name={GLYPHS[choice]} />
                </span>
              ),
              textValue: t(`priority.${choice}`),
            }}
          >
            {t(`priority.${choice}`)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </Menu>
  );
};
