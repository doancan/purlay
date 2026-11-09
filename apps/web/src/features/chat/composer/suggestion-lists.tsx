/**
 * The two lists the composer offers above its box: who an `@` would reach (`UX.md` §5) and what a `/`
 * would run (D-214). Both are a listbox in a popover with the keys that drive it printed below; the box
 * keeps focus and owns the keys, so these draw the choices and report a click or a hover, and name
 * their options so the box can point at the active one (`aria-controls`, `aria-activedescendant`).
 */
import type { User } from '@purlay/types';
import { useI18n } from '../../../i18n/i18n-provider';
import { Avatar } from '../../../ui/avatar';
import { cn } from '../../../ui/cn';
import { Kbd, keyHintsClasses } from '../../../ui/kbd';
import type { SlashName } from './slash';

/** The element ids a list and its options carry, derived from one id per composer so the box can point at them. */
export const mentionListId = (listId: string): string => listId;
export const mentionOptionId = (listId: string, index: number): string =>
  `${listId}-option-${String(index)}`;
export const commandListId = (listId: string): string => `${listId}-commands`;
export const commandOptionId = (listId: string, name: string): string =>
  `${listId}-command-${name}`;

interface SuggestionPopoverProps {
  readonly id: string;
  readonly label: string;
  /** The keys that drive the list, as `Kbd`s in spans. */
  readonly hints: React.ReactNode;
  readonly hintsClassName?: string;
  readonly children: React.ReactNode;
}

const SuggestionPopover = ({
  id,
  label,
  hints,
  hintsClassName,
  children,
}: SuggestionPopoverProps): React.JSX.Element => (
  <div className="absolute bottom-full left-0 z-popover mb-2 w-full max-w-dialog overflow-hidden rounded-2xl border-hairline border-border-subtle bg-surface-100 shadow-float">
    <div
      id={id}
      role="listbox"
      aria-label={label}
      // Choosing with the mouse must not take focus from the box: typing goes on there.
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      className="max-h-palette-list overflow-y-auto p-1"
    >
      {children}
    </div>
    <div className={cn(keyHintsClasses, hintsClassName)}>{hints}</div>
  </div>
);

export interface MentionListProps {
  readonly listId: string;
  readonly people: readonly User[];
  readonly current: number;
  readonly onChoose: (username: string) => void;
  readonly onHover: (index: number) => void;
}

export const MentionList = ({
  listId,
  people,
  current,
  onChoose,
  onHover,
}: MentionListProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SuggestionPopover
      id={mentionListId(listId)}
      label={t('mention.listLabel')}
      hintsClassName="touch-only:hidden"
      hints={
        <>
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t('mention.hint.move')}
          </span>
          <span>
            <Kbd>Enter</Kbd> {t('mention.hint.insert')}
          </span>
          <span>
            <Kbd>Esc</Kbd> {t('mention.hint.close')}
          </span>
        </>
      }
    >
      {people.map((person, index) => (
        <div
          key={person.id}
          id={mentionOptionId(listId, index)}
          role="option"
          aria-selected={index === current}
          onClick={() => {
            onChoose(person.username);
          }}
          onPointerMove={() => {
            if (index !== current) onHover(index);
          }}
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-md px-3 py-2',
            index === current && 'bg-accent-subtle',
          )}
        >
          <Avatar size="sm" name={person.displayName} username={person.username} />
          <span className="min-w-0 truncate text-body font-medium text-ink">
            {person.displayName}
          </span>
          <span className="shrink-0 font-mono text-caption text-ink-muted">@{person.username}</span>
        </div>
      ))}
    </SuggestionPopover>
  );
};

export interface CommandListProps {
  readonly listId: string;
  readonly commands: readonly SlashName[];
  readonly current: number;
  readonly onChoose: (name: SlashName) => void;
  readonly onHover: (index: number) => void;
}

export const CommandList = ({
  listId,
  commands,
  current,
  onChoose,
  onHover,
}: CommandListProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SuggestionPopover
      id={commandListId(listId)}
      label={t('slash.listLabel')}
      hints={
        <>
          <span className="touch-only:hidden">
            <Kbd>Tab</Kbd> {t('slash.hint.complete')}
          </span>
          {/* What is typed, not a key: a finger writes it too, so it is shown everywhere. */}
          <span>
            <code className="font-mono text-ink">//</code> {t('slash.hint.literal')}
          </span>
        </>
      }
    >
      {commands.map((name, index) => (
        <div
          key={name}
          id={commandOptionId(listId, name)}
          role="option"
          aria-selected={index === current}
          onClick={() => {
            onChoose(name);
          }}
          onPointerMove={() => {
            if (index !== current) onHover(index);
          }}
          className={cn(
            'flex cursor-pointer items-baseline gap-3 rounded-md px-3 py-2',
            index === current && 'bg-accent-subtle',
          )}
        >
          <span className="shrink-0 font-mono text-label text-ink">/{name}</span>
          <span className="min-w-0 truncate text-label text-ink-muted">
            {t(`slash.${name}.about`)}
          </span>
        </div>
      ))}
    </SuggestionPopover>
  );
};
