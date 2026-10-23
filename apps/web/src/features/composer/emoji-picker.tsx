/**
 * The emoji picker (D-181): a grid of the emoji a working team reaches for, in four groups, opened from
 * the composer. Choosing one writes it where the caret is; it is text like any other, and sends as typed.
 *
 * Curated, not complete: a list of three thousand with a search is a product of its own, and Unicode's
 * own emoji keyboard is one keystroke away on every platform for anyone who wants all of them. Each tile
 * is named by its emoji, which assistive technology reads as the emoji's own name.
 */
import { useI18n } from '../../i18n/i18n-provider';
import type { MessageKey } from '../../i18n/types';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuTile, MenuTiles } from '../../ui/menu';

/** Sixteen to a group: two full rows of the grid. */
const GROUPS = [
  {
    name: 'emoji.faces',
    emoji: [
      '😀',
      '😄',
      '😁',
      '😂',
      '🙂',
      '😉',
      '😊',
      '😍',
      '🤔',
      '😅',
      '😭',
      '😴',
      '😎',
      '🥳',
      '😬',
      '🙃',
    ],
  },
  {
    name: 'emoji.hands',
    emoji: [
      '👍',
      '👎',
      '👏',
      '🙌',
      '🙏',
      '💪',
      '👋',
      '🤝',
      '👀',
      '🫡',
      '🤞',
      '✌️',
      '👌',
      '🤷',
      '🙋',
      '🫶',
    ],
  },
  {
    name: 'emoji.work',
    emoji: [
      '🚀',
      '✅',
      '❌',
      '⚠️',
      '🔥',
      '💡',
      '🐛',
      '🔧',
      '🛠️',
      '📌',
      '📎',
      '📝',
      '🔒',
      '⏰',
      '📈',
      '🧪',
    ],
  },
  {
    name: 'emoji.symbols',
    emoji: [
      '❤️',
      '💯',
      '🎉',
      '⭐',
      '✨',
      '💥',
      '☕',
      '🍕',
      '🎯',
      '🏆',
      '💬',
      '🔔',
      '➕',
      '➖',
      '❓',
      '❗',
    ],
  },
] as const satisfies readonly { readonly name: MessageKey; readonly emoji: readonly string[] }[];

export const EmojiPicker = ({
  onPick,
  onClosed,
}: {
  /** The emoji chosen. */
  readonly onPick: (emoji: string) => void;
  /** Where the focus goes when the picker closes: the box the person was writing in, not the button. */
  readonly onClosed: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Menu
      align="start"
      side="top"
      returnFocus={() => {
        onClosed();
        return false;
      }}
      trigger={<IconButton label={t('composer.emoji')} glyph="emoji" />}
    >
      {GROUPS.map((group) => (
        <section key={group.name} aria-label={t(group.name)} className="flex flex-col gap-1 pb-1">
          <h3 className="px-2 pt-1 text-caption text-ink-muted">{t(group.name)}</h3>
          <MenuTiles grid>
            {group.emoji.map((emoji) => (
              <MenuTile
                key={emoji}
                label={emoji}
                checked={false}
                fill
                onSelect={() => {
                  onPick(emoji);
                }}
              >
                {emoji}
              </MenuTile>
            ))}
          </MenuTiles>
        </section>
      ))}
    </Menu>
  );
};
