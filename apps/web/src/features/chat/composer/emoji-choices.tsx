/** The curated emoji grid loads only when its menu opens. */
import { useI18n } from '../../../i18n/i18n-provider';
import type { MessageKey } from '../../../i18n/types';
import { MenuTile, MenuTiles } from '../../../ui/menu';

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

export const EmojiChoices = ({
  onPick,
}: {
  readonly onPick: (emoji: string) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <>
      {GROUPS.map((group) => (
        // Inside a menu only groups and items may stand, so the group carries the name and the caption is seen,
        // not read: a region or a heading here broke the menu's structure for a screen reader.
        <div key={group.name} className="flex flex-col gap-1 pb-1">
          <span aria-hidden="true" className="px-2 pt-1 text-caption text-ink-muted">
            {t(group.name)}
          </span>
          <MenuTiles grid label={t(group.name)}>
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
        </div>
      ))}
    </>
  );
};
