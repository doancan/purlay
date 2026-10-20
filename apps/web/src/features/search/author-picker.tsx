/**
 * Who a search is narrowed to (D-166): **Anyone**, or one of the workspace's people, each with their
 * avatar — the people the sidebar lists, the person themself first.
 *
 * The menu's radio items, not a native select: a select cannot draw a face beside a name, and a face
 * is how a person is found in a list of thirty. The menu already does the keys a picker needs —
 * arrows, typing a name's first letters, Escape back to the button — and the check says which one is
 * chosen. The button says the choice, so its name is the label and the choice together.
 */
import { useId } from 'react';
import type { WorkspaceMember } from '@purlay/types';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Avatar } from '../../ui/avatar';
import { Menu, MenuRadioGroup, MenuRadioItem } from '../../ui/menu';

/** The person themself first, then everybody by name in the reader's language. */
const authorChoices = (
  members: readonly WorkspaceMember[],
  meId: string,
  locale: string,
): WorkspaceMember[] =>
  [...members].sort((a, b) =>
    a.user.id === meId
      ? -1
      : b.user.id === meId
        ? 1
        : a.user.displayName.localeCompare(b.user.displayName, locale),
  );

interface AuthorPickerProps {
  /** The label's id: the button is named by it and by what it shows. */
  readonly labelId: string;
  readonly members: readonly WorkspaceMember[];
  readonly meId: string;
  /** The chosen person's id; null is anyone. */
  readonly value: string | null;
  /** What the chosen person is called — "Someone" for one who is no longer listed. */
  readonly chosenName: string | null;
  readonly onChange: (authorId: string | null) => void;
}

/** "Anyone" in the radio group: no id is empty, as the address leaves it out. */
const ANYONE = '';

export const AuthorPicker = ({
  labelId,
  members,
  meId,
  value,
  chosenName,
  onChange,
}: AuthorPickerProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const buttonId = useId();
  const chosen = value === null ? undefined : members.find((m) => m.user.id === value)?.user;
  return (
    <Menu
      trigger={
        <button
          type="button"
          id={buttonId}
          aria-labelledby={`${labelId} ${buttonId}`}
          className="relative flex h-control w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border-hairline border-border-strong bg-surface-100 pr-8 pl-3 text-left text-label text-ink transition-colors duration-hover ease-standard hover:bg-surface-050 max-narrow:h-touch"
        >
          {chosen === undefined ? null : (
            <Avatar name={chosen.displayName} username={chosen.username} size="sm" />
          )}
          <span className="min-w-0 truncate">{chosenName ?? t('search.anyone')}</span>
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-ink-muted">
            <Icon name="collapse" size="sm" />
          </span>
        </button>
      }
    >
      <div className="max-h-palette-list overflow-y-auto">
        <MenuRadioGroup
          value={value ?? ANYONE}
          onValueChange={(next) => {
            onChange(next === ANYONE ? null : next);
          }}
        >
          <MenuRadioItem value={ANYONE}>{t('search.anyone')}</MenuRadioItem>
          {authorChoices(members, meId, locale).map(({ user }) => (
            <MenuRadioItem
              key={user.id}
              value={user.id}
              leading={{
                node: <Avatar name={user.displayName} username={user.username} size="sm" />,
                textValue: user.displayName,
              }}
            >
              {user.displayName}
              {user.id === meId ? (
                <span className="text-ink-muted"> {t('sidebar.you')}</span>
              ) : null}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </div>
    </Menu>
  );
};
